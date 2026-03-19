import express from "express";
import cors from "cors";
import { saveToSheets, getFullData } from "./sheets.js";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// Helper para fecha BA
const getBAInfo = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    return {
        full: now.toISOString().split("T")[0],
        dia: String(now.getDate()).padStart(2, '0'),
        mes: String(now.getMonth() + 1).padStart(2, '0'),
        hora: now.getHours(),
        min: now.getMinutes()
    };
};

// --- RUTAS DE CLIENTE (CALENDARIO) ---

app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query; 
        if (!fecha) return res.status(400).json({ error: "Falta fecha" });
        const allData = await getFullData();
        const ba = getBAInfo();
        let ocupados = allData.map(d => d.turno); 

        if (fecha === ba.full) {
            for (let h = 0; h <= ba.hora; h++) {
                if (h < ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${h}:00`, `${ba.dia}/${ba.mes} - ${h}:30`);
                }
                if (h === ba.hora) {
                    ocupados.push(`${ba.dia}/${ba.mes} - ${h}:00`);
                    if (ba.min >= 30) ocupados.push(`${ba.dia}/${ba.mes} - ${h}:30`);
                }
            }
        }
        res.json({ ocupados });
    } catch (e) { res.status(500).json({ error: "Error consulta" }); }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const success = await saveToSheets({ name, phone, email, fecha, hora });
        res.json(success ? { status: "success" } : { status: "error" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RUTAS DE ADMIN (DASHBOARD) ---

app.post("/admin-login", (req, res) => {
    const { user, pass } = req.body;
    const ADMIN_USER = process.env.ADMIN_USER || "admin";
    const ADMIN_PASS = process.env.ADMIN_PASS || "clave123";

    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        res.json({ status: "success", token: "secret-admin-session-2026" });
    } else {
        res.status(401).json({ status: "error", message: "Credenciales inválidas" });
    }
});

app.get("/admin-stats", async (req, res) => {
    try {
        const allData = await getFullData();
        const PRECIO = 10000; // Podés cambiar esto o sacarlo de una Env Var
        
        // Automatización de cálculos
        const totalTurnos = allData.length;
        const ingresosTotales = totalTurnos * PRECIO;
        
        // Turnos de hoy
        const ba = getBAInfo();
        const hoyStr = `${ba.dia}/${ba.mes}`;
        const turnosHoy = allData.filter(d => d.turno.startsWith(hoyStr)).length;

        res.json({
            stats: {
                totalTurnos,
                turnosHoy,
                ingresosTotales,
                balanceHoy: turnosHoy * PRECIO
            },
            turnos: allData.reverse() // Los más nuevos primero
        });
    } catch (e) { res.status(500).json({ error: "Error stats" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Motor Admin Ready`));
