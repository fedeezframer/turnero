import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

// --- HELPER GOOGLE SHEETS ---
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

// --- LOGIN ---
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    try {
        const { data: dbUser } = await supabase.from('usuarios')
            .select('*').eq('email', user.trim().toLowerCase()).single();

        if (dbUser && dbUser.password === pass.trim()) {
            return res.json({ status: "success", slug: dbUser.slug });
        }
        res.status(401).json({ status: "error", message: "Credenciales incorrectas" });
    } catch (e) { res.status(500).json({ error: "Error DB" }); }
});

// --- STATS (Lo que le falta a tu código de 60 líneas) ---
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:E",
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1);
        
        // Fecha Arg simple
        const hoy = new Date().toLocaleString("es-AR", {timeZone: "America/Argentina/Buenos_Aires", day: '2-digit', month: '2-digit'}).replace("/","/");

        res.json({
            stats: {
                turnosHoy: dataRows.filter(r => r[3] === hoy).length,
                turnosMensuales: dataRows.length, // Opcional: filtrar por mes
                totalTurnos: dataRows.length,
                ingresosEstimados: dataRows.length * (user.precio || 10000)
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Ready on port ${PORT}`));
