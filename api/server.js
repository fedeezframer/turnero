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

// 1. CREAR RESERVA (Sincronizado con tus componentes)
app.post("/create-booking", async (req, res) => {
    const { name, phone, fecha, hora, slug } = req.body;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ message: "Agenda no encontrada" });

        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        // FORMATO PARA TUS COMPONENTES: "2026-03-19 - 15:30"
        const turnoFormateado = `${fecha} - ${hora}`;
        
        // FORMATO PARA EL DASHBOARD: "19/3/2026"
        const [y, m, d] = fecha.split("-");
        const hoyLimpio = `${parseInt(d)}/${parseInt(m)}/${y}`;

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: `${sheetName}!A:D`,
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone, turnoFormateado, hoyLimpio]] }
        });

        res.json({ status: "success" });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// 2. CONSULTAR OCUPADOS (Para que el TimeSlots los oculte)
app.get("/get-occupied", async (req, res) => {
    const { slug } = req.query;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: `${sheetName}!C:C`
        });
        const occupied = (response.data.values || []).flat();
        res.json({ ocupados: occupied });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. ADMIN STATS (Para el Dashboard)
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: `${sheetName}!A:E` 
        });
        const rows = response.data.values || [];
        const dataRows = rows.slice(1);

        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        const hoyLimpio = `${ahora.toLocaleDateString('es-AR', {...opciones, day:'numeric'})}/${ahora.toLocaleDateString('es-AR', {...opciones, month:'numeric'})}/${ahora.toLocaleDateString('es-AR', {...opciones, year:'numeric'})}`;

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
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server ready`));
