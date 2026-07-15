import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./ripple.css";
import "./auth-admin.css";
import "./react-polish.css";
import { App } from "./react-app";

createRoot(document.getElementById("app")!).render(<StrictMode><App /></StrictMode>);
