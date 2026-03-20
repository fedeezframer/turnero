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

// 1. CREAR RESERVA
app.post("/create-booking", async (req, res) => {
    const { name, phone, fecha, hora, slug } = req.body;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ message: "Agenda no encontrada" });

        const sheets = await getSheets(user.sheet_id);
        const [y, m, d] = fecha.split("-");
        const turnoFormateado = `${d}/${m} - ${hora}`;
        const hoyLimpio = `${parseInt(d)}/${parseInt(m)}/${y}`; // Formato 19/3/2026 para el Dashboard

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:D",
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone, turnoFormateado, hoyLimpio]] }
        });

        res.json({ status: "success" });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 2. CONSULTAR OCUPADOS
app.get("/get-occupied", async (req, res) => {
    const { slug } = req.query;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!C:C"
        });
        const occupied = (response.data.values || []).flat();
        res.json({ ocupados: occupied });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. ADMIN STATS (El que arreglamos antes)
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: user.sheet_id, range: "Hoja 1!A:E" });
        const rows = response.data.values || [];
        const dataRows = rows.slice(1);

        const ahora = new Date();
        const d = ahora.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: 'numeric' });
        const m = ahora.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', month: 'numeric' });
        const y = ahora.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric' });
        const hoyLimpio = `${d}/${m}/${y}`;

        const turnosHoy = dataRows.filter(r => String(r[3] || "").trim().replace(/\./g, "") === hoyLimpio);

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server on port ${PORT}`));
