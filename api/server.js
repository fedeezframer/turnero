import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors());
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

// LOGIN: Guarda el slug como llave maestra
app.post("/login", async (req, res) => {
    const { slug, password } = req.body;
    const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug.trim()).single();
    if (user && String(user.password) === String(password)) {
        return res.json({ success: true, slug: user.slug });
    }
    res.status(401).json({ success: false });
});

// STATS: La lógica "vaga" para que siempre sume
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        const sheets = await getSheets(user.sheet_id);
        const rows = (await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:C" // Leemos todo para no errarle
        })).data.values || [];

        // Generamos fecha de hoy en dos formatos: "20/03" y "20/3"
        const hoyFull = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
        const hoySimple = hoyFull.startsWith('0') ? hoyFull.substring(1) : hoyFull;

        const turnosHoy = rows.filter(r => {
            const valor = String(r[2] || ""); // Columna C
            return valor.includes(hoyFull) || valor.includes(hoySimple);
        }).length;

        res.json({
            stats: {
                turnosHoy,
                totalTurnos: Math.max(0, rows.length - 1),
                ingresosEstimados: turnosHoy * (user.precio || 10000),
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 10000);
