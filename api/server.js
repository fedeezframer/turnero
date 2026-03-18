import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const getAuth = () => new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n") : "",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export async function getFullData() {
    try {
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        const rows = await sheet.getRows();
        // Devolvemos objetos completos: { turno, phone, name }
        return rows.map(row => ({
            turno: row.get("turno"),
            phone: row.get("phone"),
            name: row.get("name")
        }));
    } catch (e) {
        console.error("Error leyendo Sheets:", e.message);
        return [];
    }
}

// Mantenemos esta para compatibilidad o la simplificamos
export async function getOccupiedSlots() {
    const data = await getFullData();
    return data.map(d => d.turno).filter(Boolean);
}

export async function saveToSheets(data) {
    try {
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, getAuth());
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        await sheet.addRow({
            name: data.name,
            phone: data.phone,
            turno: data.turno,
            semana: new Date().toLocaleDateString("es-AR")
        });
        return true;
    } catch (e) {
        return false;
    }
}
