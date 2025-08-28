import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(function (_a) {
    var mode = _a.mode;
    return ({
        plugins: [react()],
        base: mode === "production" ? "/mini-setup-wizard/" : "/", // ✅ dev=/, prod=/mini-setup-wizard/
    });
});
