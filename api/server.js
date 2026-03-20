import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

async function getSheets(sheetId) {
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

// 1. LOGIN
app.post("/login", async (req, res) => {
    const id = req.body.slug?.trim();
    const pw = req.body.password?.trim();
    try {
        const { data: user } = await supabase.from('usuarios').select('*').or(`slug.eq.${id},email.eq.${id}`).single();
        if (!user || String(user.password).trim() !== String(pw).trim()) return res.status(401).json({ success: false });
        res.json({ success: true, slug: user.slug });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 2. ADMIN STATS (LECTURA DE FORMATO DD/MM - HH:mm)
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        // Leemos las columnas A a C (Donde C es el Turno: "20/03 - 17:00")
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: `${sheetName}!A:E` 
        });
        
        const rows = response.data.values || [];
        const dataRows = rows.slice(1);

        // --- GENERAR EL BUSCADOR DE HOY (DD/MM) ---
        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        
        // Esto genera "20" y "03" (con el cero adelante si hace falta)
        const dia = ahora.toLocaleDateString('es-AR', { ...opciones, day: '2-digit' });
        const mes = ahora.toLocaleDateString('es-AR', { ...opciones, month: '2-digit' });
        
        const hoyFormatoSheet = `${dia}/${mes}`; // Queda "20/03"
        
        console.log(`Buscando turnos que empiecen con: ${hoyFormatoSheet}`);

        // Filtramos: si la celda de la columna C (índice 2) empieza con "20/03"
        const turnosHoy = dataRows.filter(r => {
            const turnoCompleto = String(r[2] || "").trim(); // Columna C
            return turnoCompleto.startsWith(hoyFormatoSheet);
        });

        res.json({
            stats: {
                turnosHoy: turnosHoy.length,
                totalTurnos: dataRows.length,
                ingresosEstimados: turnosHoy.length * (user.precio || 10000),
                nombreNegocio: user.business_name || user.slug
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. CREAR RESERVA (Mantenemos la creación normal)
app.post("/create-booking", async (req, res) => {
    const { name, phone, fecha, hora, slug } = req.body;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        const [y, m, d] = fecha.split("-");
        // Guardamos exactamente como lo lee el Admin: "20/03 - 17:00"
        const turnoParaSheet = `${d}/${m} - ${hora}`;
        const fechaParaDashboard = `${parseInt(d)}/${parseInt(m)}/${y}`;

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: `${sheetName}!A:D`,
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone, turnoParaSheet, fechaParaDashboard]] }
        });
        res.json({ status: "success" });
    } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get("/health", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Puerto ${PORT}`));
