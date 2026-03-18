import express from "express";
import cors from "cors";
import { saveToSheets, getOccupiedSlots } from "./sheets.js";

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

app.get("/check-availability", async (req, res) => {
    try {
        const ocupados = await getOccupiedSlots();
        res.json({ ocupados });
    } catch (e) {
        res.status(500).json({ error: "Error de consulta" });
    }
});

app.post("/create-booking", async (req, res) => {
    try {
        const { name, phone, email, fecha, hora } = req.body;
        const turnoString = `${fecha} - ${hora}`;

        // Guardamos en Sheets y nos olvidamos. Google se encarga del resto.
        const success = await saveToSheets({ 
            name: name || "Sin nombre", 
            phone: phone || "N/A", 
            email: email || "N/A", 
            turno: turnoString 
        });

        if (success) {
            res.json({ status: "success", message: "Reserva confirmada" });
        } else {
            res.status(500).json({ status: "error", message: "Error en Sheets" });
        }
    } catch (e) {
        res.status(500).json({ status: "error", error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API en puerto ${PORT}`));
