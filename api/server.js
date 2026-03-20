import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Función para conectar con Google Sheets
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

// --- RUTAS ---

// 1. LOGIN: Verifica usuario y devuelve el SLUG
app.post("/login", async (req, res) => {
    try {
        const { slug, password } = req.body;
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug.trim())
            .single();

        if (user && String(user.password) === String(password)) {
            return res.json({ success: true, slug: user.slug });
        }
        res.status(401).json({ success: false, message: "Credenciales inválidas" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. STATS: El motor que cuenta los turnos de hoy
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', req.params.slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        const rows = (await sheets.spreadsheets.values.get({ 
            spreadsheetId: user.sheet_id, 
            range: "A:C" // Leemos Columnas A (Nombre), B (Tel), C (Turno)
        })).data.values || [];

        // Lógica de fecha flexible (Hoy es 20/03/2026)
        const ahora = new Date();
        const opciones = { day: '2-digit', month: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' };
        const hoyFull = ahora.toLocaleDateString('es-AR', opciones); // "20/03"
        const hoySimple = hoyFull.startsWith('0') ? hoyFull.substring(1) : hoyFull; // "20/3" (si fuera el caso)

        // Filtramos la Columna C (índice 2) que contenga la fecha de hoy
        const turnosHoy = rows.filter((r, index) => {
            if (index === 0) return false; // Ignorar encabezado
            const valorCelda = String(r[2] || "");
            return valorCelda.includes(hoyFull) || valorCelda.includes(hoySimple);
        }).length;

        res.json({
            stats: {
                turnosHoy,
                totalTurnos: Math.max(0, rows.length - 1),
                ingresosEstimados: turnosHoy * (user.precio || 10000),
                businessName: user.business_name || user.slug
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. BOOKING: Guarda el turno en el Sheets
app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, fecha, hora, slug } = req.body;
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        
        const sheets = await getSheets(user.sheet_id);
        
        // Formateamos para que el Sheets reciba "DD/MM - HH:mm"
        const [y, m, d] = fecha.split("-");
        const textoTurno = `${d}/${m} - ${hora}`;

        await sheets.spreadsheets.values.append({
            spreadsheetId: user.sheet_id,
            range: "A:C",
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone, textoTurno]] }
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(process.env.PORT || 10000);
