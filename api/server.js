import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// CORS Config: Permite que Framer se conecte sin bloqueos
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Conexión a Supabase
const supabase = createClient('https://xyhuzdtpjlmtadqamywu.supabase.co', process.env.SUPABASE_KEY);

// Helper para Google Sheets
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

// --- RUTA DE LOGIN ---
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    const cleanUser = user?.trim().toLowerCase();
    
    console.log("--- NUEO INTENTO DE LOGIN ---");
    console.log("Buscando usuario:", cleanUser);

    try {
        // Buscamos en la tabla 'usuarios'
        const { data: users, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', cleanUser);

        if (error) {
            console.error("❌ Error de Supabase:", error.message);
            return res.status(500).json({ status: "error", message: "Error de DB" });
        }

        // Si la lista de usuarios vuelve vacía
        if (!users || users.length === 0) {
            console.log("❌ USUARIO NO ENCONTRADO:", cleanUser);
            return res.status(401).json({ status: "error", message: "Email no registrado" });
        }

        const dbUser = users[0];

        // Verificamos contraseña
        if (dbUser.password === pass.trim()) {
            console.log("✅ LOGIN EXITOSO para:", dbUser.slug);
            return res.json({ 
                status: "success", 
                slug: dbUser.slug, 
                token: "token_valido_2026" 
            });
        } else {
            console.log("❌ CONTRASEÑA INCORRECTA para:", cleanUser);
            return res.status(401).json({ status: "error", message: "Clave incorrecta" });
        }

    } catch (e) {
        console.error("🔥 FALLO CRÍTICO:", e.message);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// --- RUTA DE ESTADÍSTICAS ---
app.get("/admin-stats/:slug", async (req, res) => {
    const { slug } = req.params;
    console.log("Cargando stats para:", slug);

    try {
        // Traemos los datos del usuario por su slug
        const { data: user, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('slug', slug)
            .single();

        if (error || !user) return res.status(404).json({ error: "Usuario no encontrado" });

        const sheets = await getSheets(user.sheet_id);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: user.sheet_id,
            range: "Hoja 1!A:E",
        });

        const rows = response.data.values || [];
        const dataRows = rows.slice(1); // Quitamos encabezados
        
        // Fecha actual en formato DD/MM para comparar con tu Sheets
        const hoy = new Date().toLocaleString("es-AR", {
            timeZone: "America/Argentina/Buenos_Aires", 
            day: '2-digit', 
            month: '2-digit'
        });

        res.json({
            stats: {
                turnosHoy: dataRows.filter(r => r[2] && r[2].includes(hoy)).length, // Columna C/D según tu sheets.js
                turnosMensuales: dataRows.length,
                totalTurnos: dataRows.length,
                ingresosEstimados: dataRows.length * (user.precio || 10000),
                nombreNegocio: user.business_name || user.slug
            }
        });
    } catch (e) {
        console.error("❌ Error Stats:", e.message);
        res.status(500).json({ error: "No se pudieron cargar las estadísticas" });
    }
});

// Ruta de salud
app.get("/health", (req, res) => res.send("Servidor Activo 🚀"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
