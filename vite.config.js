import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
    plugins: [react()],
    base: "/mini-setup-wizard/", // Add this line
});
