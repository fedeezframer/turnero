import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// REVISÁ QUE ESTA SEA LA SECRET KEY (sb_secret...)
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

// LOGIN
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    const cleanUser = user?.trim().toLowerCase();
    const cleanPass = pass?.trim();

    try {
        const { data: users, error } = await supabase
            .from('usuarios')
            .select('*')
            .ilike('email', cleanUser);

        if (error || !users || users.length === 0) {
            return res.status(401).json({ status: "error", message: "No registrado" });
        }

        const dbUser = users[0];
        if (dbUser.password === cleanPass) {
            return res.json({ status: "success", slug: dbUser.slug });
        }
        res.status(401).json({ status: "error", message: "Clave incorrecta" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ESTADÍSTICAS
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;

    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No user" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:E", 
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1); 

        // Generamos la fecha de hoy EXACTA
        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        const d = ahora.toLocaleDateString('es-AR', { ...opciones, day: 'numeric' });
        const m = ahora.toLocaleDateString('es-AR', { ...opciones, month: 'numeric' });
        const a = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
        const hoyLimpio = `${d}/${m}/${a}`; 

        console.log(`📊 Stats para ${slug}. Buscando en Columna D: "${hoyLimpio}"`);

        const turnosHoy = dataRows.filter(r => {
            if (!r[3]) return false;
            // Quitamos puntos y espacios por si las dudas
            const fechaExcel = String(r[3]).trim().replace(/\./g, ""); 
            return fechaExcel === hoyLimpio;
        });

        res.json({
            stats: {
                turnosHoy: turnosHoy.length,
                turnosMensuales: dataRows.length,
                totalTurnos: dataRows.length,
                ingresosEstimados: turnosHoy.length * (user.precio || 10000),
                nombreNegocio: user.business_name || user.slug
            }
        });
    } catch (e) {
        console.error("Error stats:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get("/health", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Puerto ${PORT}`));
