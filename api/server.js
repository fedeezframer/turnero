import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function getSheets(sheetId) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth: await auth.getClient() });
}

// 1. OBTENER OCUPADOS (Con Filtro Estricto)
app.get("/get-occupied", async (req, res) => {
    try {
        const { slug } = req.query;
        if (!slug) return res.status(400).json({ error: "Falta slug" });

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: user.sheet_id, range: "C:C" });
        const rows = response.data.values || [];
        
        // Regex para DD/MM - HH:mm
        const formatoCorrecto = /^\d{2}\/\d{2} - \d{2}:\d{2}$/;

        const ocupados = rows
            .flat()
            .map(val => val ? val.trim() : "")
            .filter(val => formatoCorrecto.test(val));

        res.json({ success: true, ocupados });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. CREAR RESERVA (Normalizando horas a HH:mm)
app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        
        const sheets = await getSheets(user.sheet_id);
        const [y, m, d] = fecha.split("-");
        const diaNorm = String(d).padStart(2, '0');
        const mesNorm = String(m).padStart(2, '0');
        
        // Normalizamos la hora (ej: "9:30" -> "09:30")
        const [h, min] = hora.split(":");
        const horaNorm = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        
        const textoTurno = `${diaNorm}/${mesNorm} - ${horaNorm}`;
        const fechaHoyReal = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "A:D",
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone || "N/A", textoTurno, fechaHoyReal]] }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. LOGIN & STATS (Omitidos por brevedad, se mantienen igual que antes)
app.post("/login", async (req, res) => { /* ... igual ... */ });
app.get("/admin-stats/:slug", async (req, res) => { /* ... igual ... */ });

app.listen(process.env.PORT || 10000);
