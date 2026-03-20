import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// CONFIGURACIÓN DE SEGURIDAD TOTAL (CORS)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));
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

// ENDPOINT DE LOGIN
app.post("/login", async (req, res) => {
    try {
        const { slug, password } = req.body;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug.trim()).single();
        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ENDPOINT DE ESTADÍSTICAS (El que lee el Sheets)
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:C" 
        });
        
        const rows = response.data.values || [];
        
        // Lógica de fecha para hoy (Formato DD/MM)
        const hoy = new Date().toLocaleDateString('es-AR', { 
            day: '2-digit', 
            month: '2-digit', 
            timeZone: 'America/Argentina/Buenos_Aires' 
        });

        const turnosHoy = rows.filter((r, i) => i > 0 && String(r[2] || "").includes(hoy)).length;

        res.json({
            stats: {
                turnosHoy,
                ingresosEstimados: turnosHoy * (user.precio || 5000),
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) {
        console.error("Error en stats:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 10000, () => console.log("Servidor corriendo"));
