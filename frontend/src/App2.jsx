import { Routes, Route, NavLink } from "react-router-dom";
import "./App.css";
import Predict from "./pages/WaterQualityPredict2.jsx";
import WaterContaminationDetector from "./pages/WaterContaminationDetector2.jsx";
import AquaticOrganismsDetector from "./pages/AquaticOrganismsDetector2.jsx";
import Report from "./pages/WaterQualityReport2.jsx";

function Header() {
  const linkClass = ({ isActive }) =>
    `px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
      isActive
        ? "bg-sky-700 text-white"
        : "text-slate-500 hover:text-sky-700 hover:bg-sky-50"
    }`;

  return (
    <header className="px-4 py-4 bg-white text-slate-800 border-slate-200">
      <div className="flex items-center max-w-5xl gap-4 mx-auto">
        <span className="text-xl">💧</span>
        <h1 className="text-lg font-semibold text-sky-700">AquaCheck</h1>
        <nav className="flex gap-2 ml-auto">
          <NavLink to="/" end className={linkClass}>
            Quality Predictor
          </NavLink>
          <NavLink to="/detector" className={linkClass}>
            Contamination Detector
          </NavLink>
          <NavLink to="/aquatic" className={linkClass}>
            Aquatic Organisms Detector
          </NavLink>
          <NavLink to="/report" className={linkClass}>
            Quality Report
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="px-4 py-4 text-sm text-center bg-white text-slate-400 border-slate-200">
      © {new Date().getFullYear()} AquaCheck — All rights reserved.
    </footer>
  );
}

export default function App() {
  return (
    <div>
      <Header />
      <Routes>
        <Route path="/" element={<Predict />} />
        <Route path="/detector" element={<WaterContaminationDetector />} />
        <Route path="/aquatic" element={<AquaticOrganismsDetector />} />
        <Route path="/report" element={<Report />} />
      </Routes>
      <Footer />
    </div>
  );
}