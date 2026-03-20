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

// --- RUTA 1: LOGIN (LA QUE TE ESTÁ FALLANDO) ---
app.post("/login", async (req, res) => {
    const { slug, password } = req.body;
    console.log("Intentando login para:", slug);
    try {
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('slug, password')
            .eq('slug', slug)
            .eq('password', password)
            .single();

        if (error || !user) {
            return res.status(401).json({ success: false, message: "Usuario o clave incorrectos" });
        }
        res.json({ success: true, slug: user.slug });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- RUTA 2: CREAR RESERVA ---
app.post("/create-booking", async (req, res) => {
    const { name, phone, fecha, hora, slug } = req.body;
    try {
        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).json({ message: "Agenda no encontrada" });

        const sheets = await getSheets(user.sheet_id);
        const ss = await sheets.spreadsheets.get({ spreadsheetId: user.sheet_id });
        const sheetName = ss.data.sheets[0].properties.title;

        const turnoFormateado = `${fecha} - ${hora}`;
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

// --- RUTA 3: CONSULTAR OCUPADOS ---
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
