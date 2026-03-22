import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// --- CONFIGURACIÓN MIDDLEWARE ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// --- CLIENTE SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- SISTEMA DE CACHÉ EN MEMORIA ---
const globalCache = {}; 
const CACHE_DURATION = 30000; 

// --- UTILIDADES ---
const getCleanSlug = (rawSlug) => {
    if (!rawSlug) return "";
    return rawSlug
        .replace("reserva-user-", "")
        .replace("check-availability-", "")
        .replace("/", "")
        .trim();
};

async function getSheets() {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// 1. OBTENER HORARIOS OCUPADOS
app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        if (!slug) return res.status(400).json({ error: "Falta el slug" });

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "C:C", 
        });

        const rows = response.data.values || [];
        const formatoCorrecto = /^\d{2}\/\d{2} - \d{2}:\d{2}$/;

        const ocupados = rows
            .flat()
            .map(val => val ? val.trim() : "")
            .filter(val => formatoCorrecto.test(val));

        res.json({ success: true, ocupados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. CREAR RESERVA (CON FILTRO DE DUPLICADOS MEJORADO)
app.post("/create-booking", async (req, res) => {
    try {
        let { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);

        if (!name || !phone || !fecha || !hora) {
            return res.status(400).json({ error: "Faltan datos obligatorios." });
        }

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets();
        
        // Normalización de la fecha entrante (YYYY-MM-DD -> DD/MM)
        const [y, m, d] = fecha.split("-");
        const diaMesFormulario = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
        const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;

        // --- FILTRO ANTI-DUPLICADOS BLINDADO ---
        const checkResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "A:C",
        });

        const rows = checkResponse.data.values || [];
        
        // Limpiamos el teléfono entrante (solo números) para comparar
        const phoneCleanInput = phone.toString().trim().replace(/\D/g, '');

        const yaTieneTurno = rows.some(row => {
            if (!row[0] || !row[1] || !row[2]) return false;

            const nombreEnSheet = row[0].toString().trim().toLowerCase();
            const telEnSheet = row[1].toString().trim().replace(/\D/g, '');
            const turnoEnSheet = row[2].toString().trim();

            const nombreMatch = nombreEnSheet === name.trim().toLowerCase();
            const telMatch = telEnSheet === phoneCleanInput;
            const fechaMatch = turnoEnSheet.includes(diaMesFormulario);
            
            return nombreMatch && telMatch && fechaMatch;
        });

        if (yaTieneTurno) {
            return res.status(400).json({ 
                success: false, 
                error: `Ya tenés un turno agendado para el día ${diaMesFormulario}.` 
            });
        }
        // --- FIN FILTRO ANTI-DUPLICADOS ---

        const ahora = new Date();
        const fechaHoyReal = ahora.toLocaleDateString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires'
        });

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "A:D", 
            valueInputOption: "RAW",
            requestBody: { 
                values: [[name.trim(), phone.toString().trim(), textoTurnoNuevo, fechaHoyReal]] 
            }
        });

        delete globalCache[slug];
        res.json({ success: true });

    } catch (e) {
        console.error("Error en booking:", e);
        res.status(500).json({ error: e.message });
    }
});

// 3. LOGIN ADMIN
app.post("/login", async (req, res) => {
    try {
        const slug = getCleanSlug(req.body.slug);
        const { password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        
        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false, error: "Credenciales inválidas" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. ADMIN STATS
app.get("/admin-stats/:slug", async (req, res) => {
    const slug = getCleanSlug(req.params.slug);
    const now = Date.now();

    if (globalCache[slug] && (now - globalCache[slug].timestamp < CACHE_DURATION)) {
        return res.json(globalCache[slug].data);
    }

    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:E" 
        });
        
        const rows = response.data.values || [];
        const ahoraArg = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesActual = ahoraArg.getMonth() + 1;
        const diaHoyNum = ahoraArg.getDate();
        const añoActual = ahoraArg.getFullYear();
        const horaActualUnix = ahoraArg.getTime();

        let turnosHoy = 0;
        let turnosMesActual = 0;
        let turnosLista = [];
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;

            const nombreCliente = (r[0] || "Cliente").toString().trim(); 
            const telefonoCliente = (r[1] || "").toString().trim();
            const valorTurno = r[2].toString().trim(); 
            
            const partes = valorTurno.split(" - ");
            if (partes.length < 2) return;

            const [fechaParte, horaParte] = partes;
            const [dia, mes] = fechaParte.split("/").map(Number);
            const [hh, mm] = (horaParte || "00:00").split(":").map(Number);
            const fechaTurnoObj = new Date(añoActual, mes - 1, dia, hh, mm);
            const fechaTurnoUnix = fechaTurnoObj.getTime();

            if (mes === mesActual) {
                turnosMesActual++;
                if (dia === diaHoyNum) turnosHoy++;
                if (dia <= 7) semanas["Sem 1"]++;
                else if (dia <= 14) semanas["Sem 2"]++;
                else if (dia <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;
            }

            if (fechaTurnoUnix > (horaActualUnix - 900000)) {
                turnosLista.push({
                    nombre: nombreCliente,
                    telefono: telefonoCliente,
                    fecha: añoActual + "-" + String(mes).padStart(2, '0') + "-" + String(dia).padStart(2, '0'),
                    hora: horaParte || "00:00",
                    rawTurno: valorTurno
                });
            }
        });

        turnosLista.sort((a, b) => new Date(a.fecha + "T" + a.hora) - new Date(b.fecha + "T" + b.hora));

        const precioUser = user.precio || 5000;
        const ingresosMesActual = turnosMesActual * precioUser;

        const finalData = {
            stats: {
                turnosHoy,
                turnosMes: turnosMesActual,
                ingresosEstimados: ingresosMesActual,
                promedioDiario: diaHoyNum > 0 ? Math.round(ingresosMesActual / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name || user.slug,
                turnosLista: turnosLista
            }
        };

        globalCache[slug] = { timestamp: now, data: finalData };
        res.json(finalData);

    } catch (e) { 
        console.error("Error en stats:", e);
        if (globalCache[slug]) return res.json(globalCache[slug].data);
        res.status(500).json({ error: e.message }); 
    }
});

// 5. CANCELAR TURNO
app.post("/cancel-appointment", async (req, res) => {
    try {
        const { slug, rawTurno } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', cleanSlug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets();
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetIdReal = spreadsheet.data.sheets[0].properties.sheetId;

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "A:C", 
        });

        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => r[2] && r[2].trim() === rawTurno.trim());

        if (rowIndex === -1) return res.status(404).json({ error: "Turno no encontrado" });

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: user.sheet_id,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: sheetIdReal, 
                            dimension: "ROWS",
                            startIndex: rowIndex,
                            endIndex: rowIndex + 1
                        }
                    }
                }]
            }
        });

        delete globalCache[cleanSlug];
        res.json({ success: true });
    } catch (e) {
        console.error("Error al cancelar:", e);
        res.status(500).json({ error: e.message });
    }
});

// 6. REGISTRO
app.post("/register", async (req, res) => {
    try {
        const { slug, business_name, password, sheet_id, precio } = req.body;
        if (!slug || !password || !sheet_id) return res.status(400).json({ error: "Faltan campos." });

        const cleanSlug = slug.toLowerCase().trim().replace(/\s+/g, '-');
        const { data: existingUser } = await supabase.from('usuarios').select('slug').eq('slug', cleanSlug).single();

        if (existingUser) return res.status(400).json({ success: false, error: "Usuario ya existe." });

        const { error } = await supabase.from('usuarios').insert([{ 
            slug: cleanSlug, business_name: business_name || cleanSlug, 
            password, sheet_id, precio: parseInt(precio) || 5000 
        }]);

        if (error) throw error;
        res.json({ success: true, slug: cleanSlug });
    } catch (e) {
        res.status(500).json({ error: "Error en registro." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
