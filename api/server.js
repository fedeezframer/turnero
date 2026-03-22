import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg"; 
// REEMPLAZA ESTO con el ID de la carpeta que compartiste con el email de la Service Account
const FOLDER_ID = "1T9tgkJhKmtZM8GyT0vKkehTb6qAp8xDV"; 

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

// Función de Auth Unificada para Sheets y Drive
async function getGoogleAuth() {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive" 
        ],
    });
    return auth;
}

// Mantenemos getSheets para compatibilidad
async function getSheets() {
    const auth = await getGoogleAuth();
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

// 2. CREAR RESERVA
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
        
        const [y, m, d] = fecha.split("-");
        const diaMesFormulario = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
        const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;

        const checkResponse = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "A:C",
        });

        const rows = checkResponse.data.values || [];
        const phoneCleanInput = phone.toString().trim().replace(/\D/g, '');

        const yaTieneTurno = rows.some(row => {
            if (!row[0] || !row[1] || !row[2]) return false;
            const nombreEnSheet = row[0].toString().trim().toLowerCase();
            const telEnSheet = row[1].toString().trim().replace(/\D/g, '');
            const turnoEnSheet = row[2].toString().trim();

            return nombreEnSheet === name.trim().toLowerCase() && 
                   telEnSheet === phoneCleanInput && 
                   turnoEnSheet.includes(diaMesFormulario);
        });

        if (yaTieneTurno) {
            return res.status(400).json({ 
                success: false, 
                error: `Ya tenés un turno agendado para el día ${diaMesFormulario}.` 
            });
        }

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
            const partes = r[2].toString().trim().split(" - ");
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
                    nombre: r[0],
                    telefono: r[1],
                    fecha: `${añoActual}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
                    hora: horaParte,
                    rawTurno: r[2]
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
        res.status(500).json({ error: e.message });
    }
});

// 6. REGISTRO AUTOMÁTICO (FIX DEFINITIVO DE CUOTA)
app.post("/register", async (req, res) => {
    try {
        const { usuario, email, business_name, password, precio } = req.body;

        if (!usuario || !password || !email) {
            return res.status(400).json({ error: "Faltan datos obligatorios." });
        }

        const cleanSlug = usuario.toLowerCase().trim()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") 
            .replace(/\s+/g, '-') 
            .replace(/[^a-z0-9-]/g, ''); 

        const { data: existingUser } = await supabase.from('usuarios').select('slug').eq('slug', cleanSlug).single();
        if (existingUser) return res.status(400).json({ success: false, error: "El usuario ya existe." });

        const auth = await getGoogleAuth();
        const drive = google.drive({ version: "v3", auth });

        console.log("Clonando planilla maestra...");
        
        // --- PASO 1: Clonar el archivo ---
        const copyResponse = await drive.files.copy({
            fileId: MASTER_SHEET_ID,
            requestBody: {
                name: `Turnero - ${business_name || cleanSlug}`,
                parents: ["1T9tgkJhKmtZM8GyT0vKkehTb6qAp8xDV"] // Tu FOLDER_ID
            }
        });

        const newSheetId = copyResponse.data.id;

        // --- PASO 2: Transferir propiedad para saltar el error de CUOTA ---
        console.log("Transfiriendo propiedad al dueño real...");
        try {
            await drive.permissions.create({
                fileId: newSheetId,
                transferOwnership: true, 
                requestBody: {
                    role: 'owner',
                    type: 'user',
                    emailAddress: 'TU_MAIL_PERSONAL@gmail.com' // <--- TU GMAIL AQUÍ
                }
            });
        } catch (err) {
            console.warn("No se pudo transferir propiedad, pero intentaremos seguir:", err.message);
        }

        // --- PASO 3: Guardar en Supabase ---
        const { error: supabaseError } = await supabase.from('usuarios').insert([{ 
            slug: cleanSlug, 
            email: email,
            business_name: business_name || cleanSlug, 
            password: String(password), 
            sheet_id: newSheetId, 
            precio: parseInt(precio) || 10000 
        }]);

        if (supabaseError) throw supabaseError;

        res.json({ success: true, slug: cleanSlug });

    } catch (e) {
        console.error("Error en registro:", e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
