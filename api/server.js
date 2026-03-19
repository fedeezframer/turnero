import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- CONEXIÓN A SUPABASE ---
const supabaseUrl = 'https://xyhuzdtpjlmtadqamywu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HELPER FECHA ARGENTINA ---
const getBAInfo = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    const dia = String(now.getDate()).padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    return {
        hoy: `${dia}/${mes}`,
        mesActual: `/${mes}`,
        full: now.toISOString().split("T")[0]
    };
};

// --- HELPER GOOGLE SHEETS ---
async function getSheetsInstance(clientSheetId) {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        },
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const client = await auth.getClient();
    return { sheets: google.sheets({ version: "v4", auth: client }), sheetId: clientSheetId };
}

// --- RUTA LOGIN ---
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    try {
        const { data, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', user)
            .single();

        if (data && data.password === pass) {
            res.json({ status: "success", token: "sesion_valida_2026", slug: data.slug });
        } else {
            res.status(401).json({ status: "error", message: "Credenciales incorrectas" });
        }
    } catch (e) {
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// --- RUTA ESTADÍSTICAS ---
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).json({ error: "No existe el usuario" });

        const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "Hoja 1!A:E",
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1);
        const ba = getBAInfo();

        const turnosHoy = dataRows.filter(r => r[3] === ba.hoy).length;
        const turnosMensuales = dataRows.filter(r => r[3] && r[3].includes(ba.mesActual)).length;

        res.json({
            stats: {
                turnosHoy,
                turnosMensuales,
                ingresosEstimados: turnosMensuales * (user.precio || 10000),
                horasTrabajadas: (turnosMensuales * 0.75).toFixed(1),
                totalTurnos: dataRows.length,
                nombreNegocio: user.business_name
            },
            turnos: dataRows.reverse().slice(0, 10) // Mandamos los últimos 10
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RUTA CREAR TURNO ---
app.post("/create-booking/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const { name, phone, email, fecha, hora } = req.body;

        const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
        if (!user) return res.status(404).send("Error");

        const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);

        await sheets.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Hoja 1!A:E",
            valueInputOption: "RAW",
            requestBody: { values: [[name, phone, email, fecha, hora]] },
        });

        res.json({ status: "success" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Plataforma Online en puerto ${PORT}`));
