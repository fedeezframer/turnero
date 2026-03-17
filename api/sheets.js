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

        // Usamos EXACTAMENTE los nombres de las columnas de tu foto
        await sheet.addRow({
            name: data.name,           // Antes decía 'nombre'
            phone: data.phone,         // Antes decía 'telefono'
            turno: data.turno,         // Este sí funcionaba
            semana: new Date().toLocaleDateString("es-AR", { week: "numeric" }) 
        });
        return true;
    } catch (e) {
        console.error("Error al escribir en Sheets:", e.message);
        return false;
    }
}
}
