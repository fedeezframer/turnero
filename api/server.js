import express from "express";
import cors from "cors";
import { createClient } from '@supabase/supabase-js';
import { google } from "googleapis";

const app = express();

// Configuración de CORS ultra-permisiva para que Framer no bloquee nada
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const supabaseUrl = 'https://xyhuzdtpjlmtadqamywu.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

app.post("/admin-login", async (req, res) => {
    const { user, pass } = req.body;
    
    // ESTO VA A APARECER EN LOS LOGS DE RENDER
    console.log("--- INTENTO DE LOGIN ---");
    console.log("Usuario recibido:", user);
    console.log("Clave recibida:", pass);

    if (!supabaseKey) {
        console.error("❌ ERROR: No hay SUPABASE_KEY en Render");
        return res.status(500).json({ status: "error", message: "Error de configuración en servidor" });
    }

    try {
        const { data: dbUser, error } = await supabase
            .from('usuarios')
            .select('*')
            .eq('email', user.trim().toLowerCase())
            .single();

        if (error) {
            console.error("❌ Error de Supabase:", error.message);
            return res.status(401).json({ status: "error", message: "Usuario no encontrado" });
        }

        if (dbUser && dbUser.password === pass.trim()) {
            console.log("✅ LOGIN EXITOSO para:", dbUser.slug);
            return res.json({ status: "success", token: "valido", slug: dbUser.slug });
        } else {
            console.log("❌ CLAVE INCORRECTA");
            return res.status(401).json({ status: "error", message: "Clave incorrecta" });
        }
    } catch (e) {
        console.error("🔥 ERROR CRÍTICO:", e.message);
        res.status(500).json({ error: "Error interno" });
    }
});

// Ruta simple para probar si la API está viva
app.get("/health", (req, res) => res.send("API VIVA"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API en puerto ${PORT}`));
