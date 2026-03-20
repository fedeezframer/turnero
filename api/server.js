import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
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

// ESTA ES LA RUTA DE LOGIN
app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    const cleanUser = user?.trim().toLowerCase();
    const cleanPass = pass?.trim();

    console.log("-----------------------------------------");
    console.log("🔍 INTENTO DE LOGIN RECIBIDO:");
    console.log("USUARIO ESCRITO:", `"${cleanUser}"`);
    console.log("CLAVE ESCRITA:", `"${cleanPass}"`);

    try {
        // Buscamos sin que importen mayúsculas (ilike)
        const { data: users, error } = await supabase
            .from('usuarios')
            .select('*')
            .ilike('email', cleanUser);

        if (error) {
            console.error("❌ ERROR SUPABASE:", error.message);
            return res.status(500).json({ status: "error", message: "Error DB" });
        }

        if (!users || users.length === 0) {
            console.log("❌ RESULTADO: Usuario no encontrado en la tabla 'usuarios'");
            return res.status(401).json({ status: "error", message: "Email no registrado" });
        }

        const dbUser = users[0];
        console.log("✅ USUARIO ENCONTRADO EN DB:", dbUser.email);

        if (dbUser.password === cleanPass) {
            console.log("✅ CLAVE CORRECTA. Entrando como:", dbUser.slug);
            return res.json({ status: "success", slug: dbUser.slug, token: "OK_2026" });
        } else {
            console.log("❌ CLAVE INCORRECTA. DB tiene:", `"${dbUser.password}"`);
            return res.status(401).json({ status: "error", message: "Clave incorrecta" });
        }

    } catch (e) {
        console.error("🔥 FALLO CRÍTICO:", e.message);
        res.status(500).json({ error: "Error interno" });
    }
});

// ESTA ES LA RUTA DE STATS (LA QUE LEE EL EXCEL)
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

        const ahora = new Date();
        const opciones = { timeZone: 'America/Argentina/Buenos_Aires' };
        const dia = ahora.toLocaleDateString('es-AR', { ...opciones, day: 'numeric' });
        const mes = ahora.toLocaleDateString('es-AR', { ...opciones, month: 'numeric' });
        const anio = ahora.toLocaleDateString('es-AR', { ...opciones, year: 'numeric' });
        const hoyArg = `${dia}/${mes}/${anio}`;

        const turnosHoy = dataRows.filter(r => {
            const fechaFila = r[3] ? String(r[3]).trim() : "";
            return fechaFila === hoyArg;
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
        res.status(500).json({ error: e.message });
    }
});

app.get("/health", (req, res) => res.send("OK"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Servidor en puerto ${PORT}`));
