import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots, getFullData } from "./sheets.js"; // Sumamos getFullData

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

app.get("/check-availability", async (req, res) => {
    try {
        const { fecha } = req.query; 
        const ocupadosDelExcel = await getOccupiedSlots();
        const nowBA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
        const hoyBA = nowBA.getDate().toString();
        const horaActual = nowBA.getHours();
        const minActual = nowBA.getMinutes();

        let bloqueados = [...ocupadosDelExcel];

        if (fecha === hoyBA) {
            for (let h = 0; h <= horaActual; h++) {
                if (h < horaActual) {
                    bloqueados.push(`${fecha} - ${h}:00`, `${fecha} - ${h}:30`);
                }
                if (h === horaActual) {
                    bloqueados.push(`${fecha} - ${h}:00`);
                    if (minActual >= 30) bloqueados.push(`${fecha} - ${h}:30`);
                }
            }
        }
        res.json({ ocupados: bloqueados });
    } catch (e) {
        res.status(500).json({ error: "Error de consulta" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        
        // --- VALIDACIÓN ANTI-DUPLICADOS ---
        const rows = await getFullData();
        const yaTieneTurno = rows.some(row => row.phone === phone);

        if (yaTieneTurno) {
            return res.status(400).json({ 
                status: "error", 
                message: "Ya tenés un turno reservado. No podés sacar otro." 
            });
        }
        // ----------------------------------

        const turnoString = `${fecha} - ${hora}`;
        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            res.status(500).json({ status: "error", message: "Error al guardar en la base de datos" });
        }
    } catch (e) {
        res.status(500).json({ status: "error", error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API activa en puerto ${PORT}`));
