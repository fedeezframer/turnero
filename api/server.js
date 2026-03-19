import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// --- CONEXIÓN A SUPABASE ---
// Poné tu ANON_KEY acá o en las variables de entorno de Render
const supabaseUrl = 'https://xyhuzdtpjlmtadqamywu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY; 
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HELPER GOOGLE SHEETS DINÁMICO ---
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

// --- RUTA LOGIN MULTI-CLIENTE ---
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;

    // Buscamos al usuario por email en tu tabla de Supabase
    const { data, error } = await supabase
        .from('usuarios')
        .select('*')
        .eq('email', user)
        .single();

    if (data && data.password === pass) {
        res.json({ 
            status: "success", 
            token: "sesion_valida_2026", 
            slug: data.slug // Le devolvemos su "marca"
        });
    } else {
        res.status(401).json({ status: "error", message: "Datos incorrectos" });
    }
});

// --- RUTA STATS DINÁMICA ---
app.get("/admin-stats/:slug", async (req, res) => {
    try {
        const { slug } = req.params;
        
        // 1. Buscamos qué Sheet le pertenece a este slug
        const { data: user } = await supabase.from('usuarios').select('*').eq('slug', slug).single();
        if (!user) return res.status(404).send("Usuario no encontrado");

        // 2. Traemos los datos de SU hoja de Google
        const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "Hoja 1!A:E",
        });

        const rows = response.data.values || [];
        const cleanData = rows.slice(1).map(r => ({ name: r[0], phone: r[1], email: r[2], turno: `${r[3]} - ${r[4]}` }));

        res.json({
            stats: {
                totalTurnos: cleanData.length,
                ingresosTotales: cleanData.length * (user.precio || 10000),
                nombreNegocio: user.business_name
            },
            turnos: cleanData.reverse()
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RUTA CREAR TURNO (Desde el Calendario) ---
app.post("/create-booking/:slug", async (req, res) => {
    const { slug } = req.params;
    const { name, phone, email, fecha, hora } = req.body;

    const { data: user } = await supabase.from('usuarios').select('sheet_id').eq('slug', slug).single();
    const { sheets, sheetId } = await getSheetsInstance(user.sheet_id);

    await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: "Hoja 1!A:E",
        valueInputOption: "RAW",
        requestBody: { values: [[name, phone, email, fecha, hora]] },
    });

    res.json({ status: "success" });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Plataforma Multi-Cliente Online`));
