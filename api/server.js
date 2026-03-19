import express from "express";
import cors from "cors";
import { saveToSheets, getFullData } from "./sheets.js";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// Configuración predeterminada (puedes mover esto a Env Vars en Render)
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "clave123";
const PRECIO_TURNO = 10000; 

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

// --- RUTA LOGIN ---
app.post("/admin-login", (req, res) => {
    const { user, pass } = req.body;
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
        res.json({ status: "success", token: "sesion_valida_2026" });
    } else {
        res.status(401).json({ status: "error", message: "Credenciales incorrectas" });
    }
});

// --- RUTA ESTADÍSTICAS DASHBOARD ---
app.get("/admin-stats", async (req, res) => {
    try {
        const allData = await getFullData();
        const ba = getBAInfo();
        const hoyStr = `${ba.dia}/${ba.mes}`;
        
        const turnosHoy = allData.filter(d => d.turno.startsWith(hoyStr)).length;
        
        res.json({
            stats: {
                totalTurnos: allData.length,
                turnosHoy: turnosHoy,
                ingresosTotales: allData.length * PRECIO_TURNO,
                balanceHoy: turnosHoy * PRECIO_TURNO
            },
            turnos: allData.reverse() // Los últimos primero
        });
    } catch (e) {
        res.status(500).json({ error: "Error al obtener datos" });
    }
});

// --- RUTAS DE RESERVA (CALENDARIO) ---
app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query;
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
    } catch (e) { res.status(500).json({ error: "Error" }); }
});

app.post("/create-booking", async (req, res) => {
    try {
        const success = await saveToSheets(req.body);
        res.json(success ? { status: "success" } : { status: "error" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server Ready`));
