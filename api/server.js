import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// --- CONFIGURACIÓN GLOBAL ---
// Ahora todos los usuarios usan esta misma planilla
const MASTER_SHEET_ID = "1CYF1IJFEKibbkXTKco-o13ZbMo6KpkT5oJj35Z3q4hg"; 

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

async function getGoogleAuth() {
    return new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
}

async function getSheets() {
    const auth = await getGoogleAuth();
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
}

// 1. REGISTRO: Ahora solo guarda en Supabase, apuntando a la planilla única
app.post("/register", async (req, res) => {
    try {
        const { usuario, email, business_name, password, precio } = req.body;
        if (!usuario || !password || !email) return res.status(400).json({ error: "Faltan datos." });

        const cleanSlug = usuario.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const { error: supabaseError } = await supabase.from('usuarios').insert([{ 
            slug: cleanSlug, 
            email,
            business_name: business_name || cleanSlug, 
            password: String(password), 
            sheet_id: MASTER_SHEET_ID, // ID Fijo para todos
            precio: parseInt(precio) || 10000 
        }]);

        if (supabaseError) throw supabaseError;
        res.json({ success: true, slug: cleanSlug });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. OBTENER OCUPADOS: Filtra por la columna E (Slug)
app.get("/get-occupied", async (req, res) => {
    try {
        const slug = getCleanSlug(req.query.slug);
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E", 
        });

        const rows = response.data.values || [];
        // Filtramos: solo turnos donde la columna E coincida con el slug del barbero
        const ocupados = rows
            .filter(row => row[4] === slug) 
            .map(row => row[2]); 

        res.json({ success: true, ocupados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. CREAR RESERVA: Guarda el slug en la columna E
app.post("/create-booking", async (req, res) => {
    try {
        let { name, phone, fecha, hora, slug: rawSlug } = req.body;
        const slug = getCleanSlug(rawSlug);

        const sheets = await getSheets();
        const [y, m, d] = fecha.split("-");
        const diaMesFormulario = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
        const textoTurnoNuevo = `${diaMesFormulario} - ${hora}`;

        const ahora = new Date();
        const fechaHoyReal = ahora.toLocaleDateString('es-AR', {
            day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires'
        });

        // Guardamos: Nombre(A), Tel(B), Turno(C), Registro(D), SLUG(E)
        await sheets.spreadsheets.values.append({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E", 
            valueInputOption: "RAW",
            requestBody: { 
                values: [[name.trim(), phone.toString().trim(), textoTurnoNuevo, fechaHoyReal, slug]] 
            }
        });

        delete globalCache[slug];
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. LOGIN ADMIN
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

// 5. ADMIN STATS: Filtra turnos por slug para las estadísticas
app.get("/admin-stats/:slug", async (req, res) => {
    const slug = getCleanSlug(req.params.slug);
    const now = Date.now();

    if (globalCache[slug] && (now - globalCache[slug].timestamp < CACHE_DURATION)) {
        return res.json(globalCache[slug].data);
    }

    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: MASTER_SHEET_ID, 
            range: "A:E" 
        });
        
        const allRows = response.data.values || [];
        // Filtramos solo las filas que pertenecen a este barbero (columna E)
        const rows = allRows.filter((r, i) => i === 0 || r[4] === slug);

        const ahoraArg = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        const mesActual = ahoraArg.getMonth() + 1;
        const diaHoyNum = ahoraArg.getDate();
        const añoActual = ahoraArg.getFullYear();

        let turnosHoy = 0, turnosMesActual = 0, turnosLista = [];
        let semanas = { "Sem 1": 0, "Sem 2": 0, "Sem 3": 0, "Sem 4": 0 };

        rows.forEach((r, i) => {
            if (i === 0 || !r[2]) return;
            const partes = r[2].toString().trim().split(" - ");
            if (partes.length < 2) return;

            const [fechaParte, horaParte] = partes;
            const [dia, mes] = fechaParte.split("/").map(Number);

            if (mes === mesActual) {
                turnosMesActual++;
                if (dia === diaHoyNum) turnosHoy++;
                if (dia <= 7) semanas["Sem 1"]++;
                else if (dia <= 14) semanas["Sem 2"]++;
                else if (dia <= 21) semanas["Sem 3"]++;
                else semanas["Sem 4"]++;
            }

            turnosLista.push({
                nombre: r[0],
                telefono: r[1],
                fecha: `${añoActual}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
                hora: horaParte,
                rawTurno: r[2]
            });
        });

        const finalData = {
            stats: {
                turnosHoy,
                turnosMes: turnosMesActual,
                ingresosEstimados: turnosMesActual * (user.precio || 10000),
                promedioDiario: diaHoyNum > 0 ? Math.round((turnosMesActual * (user.precio || 10000)) / diaHoyNum) : 0,
                chartData: Object.keys(semanas).map(key => ({ label: key, turnos: semanas[key] })),
                businessName: user.business_name || user.slug,
                turnosLista: turnosLista.sort((a, b) => new Date(a.fecha + "T" + a.hora) - new Date(b.fecha + "T" + b.hora))
            }
        };

        globalCache[slug] = { timestamp: now, data: finalData };
        res.json(finalData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. CANCELAR: Busca la fila que coincida con el slug y el turno
app.post("/cancel-appointment", async (req, res) => {
    try {
        const { slug, rawTurno } = req.body;
        const cleanSlug = getCleanSlug(slug);

        const sheets = await getSheets();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: MASTER_SHEET_ID,
            range: "A:E", 
        });

        const rows = response.data.values || [];
        // Buscamos la fila donde coincida el turno (C) Y el slug (E)
        const rowIndex = rows.findIndex(r => r[2] === rawTurno && r[4] === cleanSlug);

        if (rowIndex === -1) return res.status(404).json({ error: "Turno no encontrado" });

        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: MASTER_SHEET_ID });
        const sheetIdReal = spreadsheet.data.sheets[0].properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: MASTER_SHEET_ID,
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
