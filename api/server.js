import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Supabase
const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

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

// 1. RUTA LOGIN (CON LOGS DETALLADOS)
app.post("/login", async (req, res) => {
    const slug = req.body.slug?.trim();
    const password = req.body.password?.trim();

    console.log(`--- Intento de Login ---`);
    console.log(`Usuario: [${slug}]`);
    console.log(`Password enviada: [${password}]`);

    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (error || !user) {
            console.log("❌ Resultado: Usuario no encontrado en la base de datos.");
            return res.status(401).json({ success: false, message: "Usuario no encontrado" });
        }

        // Comparación manual para evitar líos de tipos de datos
        if (String(user.password).trim() !== String(password).trim()) {
            console.log(`❌ Resultado: Contraseña incorrecta. (DB tiene: [${user.password}])`);
            return res.status(401).json({ success: false, message: "Contraseña incorrecta" });
        }

        console.log("✅ Resultado: Login exitoso.");
        res.json({ success: true, slug: user.slug });

    } catch (e) {
        console.error("🔥 Error crítico en /login:", e.message);
        res.status(500).json({ success: false, message: "Error interno del servidor" });
    }
});

// 2. RUTA CREAR RESERVA
app.post("/create-booking", async (req, res) => {
    const { name, phone, fecha, hora, slug } = req.body;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ message: "Agenda no encontrada" });

        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        // Formato para ocultar turnos: "2026-03-19 - 15:30"
        const turnoFormateado = `${fecha} - ${hora}`;
        // Formato para el Dashboard: "19/3/2026"
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

// 3. RUTA CONSULTAR OCUPADOS
app.get("/get-occupied", async (req, res) => {
    const { slug } = req.query;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
        
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

// 4. RUTA ADMIN STATS (DASHBOARD)
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;
    try {
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

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
        const d = ahora.toLocaleDateString('es-AR', { ...opciones, day: 'numeric' });
        const m = ahora.toLocaleDateString('es-AR', { ...opciones, month: 'numeric' });
        const y = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
        const hoyLimpio = `${d}/${m}/${y}`;

        const turnosHoy = dataRows.filter(r => String(r[3] || "").trim() === hoyLimpio);

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

// Ruta de salud
app.get("/health", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});
