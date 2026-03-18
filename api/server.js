import express from "express";
import cors from "cors";
import { saveToSheets, getFullData } from "./sheets.js";

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query; 
        const allData = await getFullData();
        
        const nowBA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        const hoyBA = nowBA.getDate().toString();
        const horaActual = nowBA.getHours();
        const minActual = nowBA.getMinutes();

        // Filtramos solo turnos que son de hoy en adelante (ignoramos historial viejo)
        let ocupados = allData
            .filter(d => {
                const diaTurno = parseInt(d.turno.split(" - ")[0]);
                // Si el día del turno es mayor o igual al día actual (simplificado para el mes)
                return diaTurno >= parseInt(hoyBA);
            })
            .map(d => d.turno);

        if (fecha === hoyBA) {
            for (let h = 0; h <= horaActual; h++) {
                if (h < horaActual) {
                    ocupados.push(`${fecha} - ${h}:00`, `${fecha} - ${h}:30`);
                }
                if (h === horaActual) {
                    ocupados.push(`${fecha} - ${h}:00`);
                    if (minActual >= 30) ocupados.push(`${fecha} - ${h}:30`);
                }
            }
        }
        res.json({ ocupados });
    } catch (e) {
        res.status(500).json({ error: "Error de consulta" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const rows = await getFullData();
        
        const nowBA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        const hoyBA = nowBA.getDate().toString();

        // VALIDACIÓN: ¿Tiene un turno pendiente para hoy o el futuro?
        const tieneTurnoActivo = rows.some(row => {
            const diaTurno = parseInt(row.turno.split(" - ")[0]);
            return row.phone === phone && diaTurno >= parseInt(hoyBA);
        });

        if (tieneTurnoActivo) {
            return res.status(400).json({ status: "error", message: "Ya tenés un turno activo." });
        }

        const success = await saveToSheets({ name, phone, email, turno: `${fecha} - ${hora}` });
        res.json(success ? { status: "success" } : { status: "error" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API activa`));
