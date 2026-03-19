import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const supabaseUrl = 'https://xyhuzdtpjlmtadqamywu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

// Helper para fecha de Argentina
const getBAInfo = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    return {
        hoyStr: `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`,
        mesActual: `/${String(now.getMonth() + 1).padStart(2, '0')}`
    };
};

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

app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    const { data } = await supabase.from('usuarios').select('*').eq('email', user).single();
    if (data && data.password === pass) {
        res.json({ status: "success", token: "sesion_valida_2026", slug: data.slug });
    } else {
        res.status(401).json({ status: "error" });
    }
});

app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).send("User error");

        const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Hoja 1!A:E" });

        const rows = response.data.values || [];
        const cleanData = rows.slice(1).map(r => ({ name: r[0], phone: r[1], fecha: r[3], turno: `${r[3]} - ${r[4]}` }));
        
        const ba = getBAInfo();
        const turnosHoy = cleanData.filter(d => d.fecha === ba.hoyStr).length;
        const turnosMes = cleanData.filter(d => d.fecha.includes(ba.mesActual)).length;

        res.json({
            stats: {
                turnosHoy: turnosHoy,
                turnosMensuales: turnosMes,
                ingresosEstimados: turnosMes * (user.precio || 10000),
                horasTrabajadas: (turnosMes * 0.75).toFixed(1), // 45 min por turno
                totalTurnos: cleanData.length,
                nombreNegocio: user.business_name
            },
            turnos: cleanData.reverse()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/create-booking/:slug", async (req, res) => {
    const { slug } = req.params;
    const { name, phone, email, fecha, hora } = req.body;
    const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
    const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);
    await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId, range: "Hoja 1!A:E", valueInputOption: "RAW",
        requestBody: { values: [[name, phone, email, fecha, hora]] },
    });
    res.json({ status: "success" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server Multi-tenant Ready`));
