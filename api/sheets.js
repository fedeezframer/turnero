import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const getAuth = () => new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export async function getOccupiedSlots() {
    try {
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        return rows.map(row => row.get("turno")).filter(Boolean);
    } catch (e) {
        console.error("Error leyendo Sheets:", e.message);
        return [];
    }
}

export async function saveToSheets(data) {
    try {
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];

        // Mapeo exacto a las columnas de tu imagen
        await sheet.addRow({
            name: data.name || "N/A",
            phone: data.phone || "N/A",
            turno: data.turno || "N/A",
            semana: new Date().toLocaleDateString("es-AR")
        });
        return true;
    } catch (e) {
        console.error("Error al escribir en Sheets:", e.message);
        return false;
    }
}
