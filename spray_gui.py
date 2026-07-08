#!/usr/bin/env python3
"""Tkinter GUI for the spray deposition simulator (spray_sim.py).

Left panel: part geometry (cylinder, Z/R profile, or STL), nozzle and
process parameters, and the nozzle path as a time-keyed waypoint table —
one line per waypoint, ``t, x, y, z, roll, pitch, yaw`` (angles in
degrees), linearly interpolated in time during the simulation.
Right panel: embedded matplotlib results (unrolled thickness map and
axial profile).

Run with:  python spray_gui.py
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
import traceback
from tkinter import filedialog, messagebox, ttk

import numpy as np
import matplotlib

matplotlib.use("TkAgg")
from matplotlib.backends.backend_tkagg import (  # noqa: E402
    FigureCanvasTkAgg,
    NavigationToolbar2Tk,
)
from matplotlib.figure import Figure  # noqa: E402

from spray_sim import Nozzle, Part, WaypointPath, make_figure, simulate  # noqa: E402

DEFAULT_WAYPOINTS = """\
# t,   x,  y,   z, roll, pitch, yaw   (mm / deg; linear interp in time)
  0,   0,  0,  20,    0,    45,   0
 20,   0,  0, 180,    0,    45,   0
"""

DEFAULT_PROFILE = """\
# z, r  (one point per line, revolved about the z axis)
  0, 50
200, 50
"""


class SprayGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Spray Deposition Simulator")
        self.minsize(1050, 620)

        self._worker: threading.Thread | None = None
        self._queue: queue.Queue = queue.Queue()
        self._last_result: tuple[Part, np.ndarray] | None = None

        self._build_controls()
        self._build_plot_area()
        self.after(100, self._poll_queue)

    # -- layout -------------------------------------------------------------

    def _build_controls(self) -> None:
        left = ttk.Frame(self, padding=8)
        left.pack(side=tk.LEFT, fill=tk.Y)

        # Part -----------------------------------------------------------
        part_box = ttk.LabelFrame(left, text="Part", padding=6)
        part_box.pack(fill=tk.X, pady=(0, 6))

        self.part_mode = tk.StringVar(value="cylinder")
        row = ttk.Frame(part_box)
        row.pack(fill=tk.X)
        for label, mode in (("Cylinder", "cylinder"),
                            ("Z/R profile", "profile"),
                            ("STL", "stl")):
            ttk.Radiobutton(
                row, text=label, value=mode, variable=self.part_mode,
                command=self._on_part_mode,
            ).pack(side=tk.LEFT, padx=(0, 8))

        self.cyl_frame = ttk.Frame(part_box)
        self.radius_var = self._labeled_entry(self.cyl_frame, "Radius [mm]", "50", 0)
        self.height_var = self._labeled_entry(self.cyl_frame, "Height [mm]", "200", 1)

        self.profile_frame = ttk.Frame(part_box)
        ttk.Label(self.profile_frame, text="Z/R points (z, r per line):").pack(anchor=tk.W)
        self.profile_text = tk.Text(self.profile_frame, width=34, height=5,
                                    font=("TkFixedFont",))
        self.profile_text.insert("1.0", DEFAULT_PROFILE)
        self.profile_text.pack(fill=tk.X)

        self.stl_frame = ttk.Frame(part_box)
        self.stl_path_var = tk.StringVar()
        srow = ttk.Frame(self.stl_frame)
        srow.pack(fill=tk.X)
        ttk.Entry(srow, textvariable=self.stl_path_var).pack(
            side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(srow, text="Browse…", command=self._browse_stl).pack(
            side=tk.LEFT, padx=(4, 0))
        self.flip_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(self.stl_frame, text="Flip normals",
                        variable=self.flip_var).pack(anchor=tk.W)

        common = ttk.Frame(part_box)
        common.pack(fill=tk.X, pady=(4, 0))
        self.surface_var = tk.StringVar(value="inner")
        ttk.Label(common, text="Coat surface").grid(row=0, column=0, sticky=tk.W)
        self.surface_combo = ttk.Combobox(
            common, textvariable=self.surface_var, values=("inner", "outer"),
            state="readonly", width=8)
        self.surface_combo.grid(row=0, column=1, sticky=tk.W, padx=4)
        self.n_axial_var = self._labeled_entry(common, "Axial samples", "120", 1)
        self.n_phi_var = self._labeled_entry(common, "Azimuthal samples", "180", 2)

        self._on_part_mode()

        # Nozzle -----------------------------------------------------------
        noz_box = ttk.LabelFrame(left, text="Nozzle", padding=6)
        noz_box.pack(fill=tk.X, pady=(0, 6))
        self.cone_var = self._labeled_entry(noz_box, "Cone half-angle [deg]", "15", 0)
        self.flow_var = self._labeled_entry(noz_box, "Flow rate [mm³/s]", "20", 1)
        self.eff_var = self._labeled_entry(noz_box, "Efficiency (0–1)", "1.0", 2)
        ttk.Label(noz_box, text="Cone profile").grid(row=3, column=0, sticky=tk.W)
        self.profile_var = tk.StringVar(value="gaussian")
        ttk.Combobox(noz_box, textvariable=self.profile_var,
                     values=("gaussian", "cosine", "uniform"),
                     state="readonly", width=10).grid(
            row=3, column=1, sticky=tk.W, padx=4, pady=1)

        # Process ----------------------------------------------------------
        proc_box = ttk.LabelFrame(left, text="Process", padding=6)
        proc_box.pack(fill=tk.X, pady=(0, 6))
        self.rpm_var = self._labeled_entry(proc_box, "Part speed [rpm]", "120", 0)
        self.duration_var = self._labeled_entry(
            proc_box, "Duration [s] (blank = last waypoint)", "", 1)
        self.dt_var = self._labeled_entry(
            proc_box, "Time step [s] (blank = auto)", "", 2)

        # Nozzle path --------------------------------------------------------
        path_box = ttk.LabelFrame(
            left, text="Nozzle path — t, x, y, z, roll, pitch, yaw [deg]",
            padding=6)
        path_box.pack(fill=tk.BOTH, expand=True, pady=(0, 6))
        self.path_text = tk.Text(path_box, width=44, height=8,
                                 font=("TkFixedFont",), undo=True)
        self.path_text.insert("1.0", DEFAULT_WAYPOINTS)
        self.path_text.pack(fill=tk.BOTH, expand=True)
        prow = ttk.Frame(path_box)
        prow.pack(fill=tk.X, pady=(4, 0))
        ttk.Button(prow, text="Load CSV…", command=self._load_path).pack(side=tk.LEFT)
        ttk.Button(prow, text="Save CSV…", command=self._save_path).pack(
            side=tk.LEFT, padx=4)

        # Actions ------------------------------------------------------------
        arow = ttk.Frame(left)
        arow.pack(fill=tk.X)
        self.run_btn = ttk.Button(arow, text="Run simulation", command=self._run)
        self.run_btn.pack(side=tk.LEFT)
        ttk.Button(arow, text="Save plot…", command=self._save_plot).pack(
            side=tk.LEFT, padx=4)
        ttk.Button(arow, text="Export thickness CSV…",
                   command=self._export_csv).pack(side=tk.LEFT)

        self.progress = ttk.Progressbar(left, maximum=1.0)
        self.progress.pack(fill=tk.X, pady=(6, 2))
        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(left, textvariable=self.status_var, wraplength=340).pack(
            anchor=tk.W)

    def _build_plot_area(self) -> None:
        right = ttk.Frame(self, padding=(0, 8, 8, 8))
        right.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.figure = Figure(figsize=(8, 5), dpi=100)
        self.canvas = FigureCanvasTkAgg(self.figure, master=right)
        self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)
        NavigationToolbar2Tk(self.canvas, right)
        ax = self.figure.add_subplot(111)
        ax.set_axis_off()
        ax.text(0.5, 0.5, "Set parameters and press “Run simulation”.",
                ha="center", va="center")
        self.canvas.draw_idle()

    @staticmethod
    def _labeled_entry(parent, label: str, default: str, row: int) -> tk.StringVar:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky=tk.W)
        var = tk.StringVar(value=default)
        ttk.Entry(parent, textvariable=var, width=10).grid(
            row=row, column=1, sticky=tk.W, padx=4, pady=1)
        return var

    # -- part mode / file pickers -------------------------------------------

    def _on_part_mode(self) -> None:
        for frame in (self.cyl_frame, self.profile_frame, self.stl_frame):
            frame.pack_forget()
        mode = self.part_mode.get()
        frame = {"cylinder": self.cyl_frame, "profile": self.profile_frame,
                 "stl": self.stl_frame}[mode]
        frame.pack(fill=tk.X, pady=(4, 0))
        # surface selection only applies to revolved geometry
        self.surface_combo.configure(
            state="disabled" if mode == "stl" else "readonly")

    def _browse_stl(self) -> None:
        path = filedialog.askopenfilename(
            title="Select STL", filetypes=[("STL files", "*.stl"), ("All", "*")])
        if path:
            self.stl_path_var.set(path)

    def _load_path(self) -> None:
        path = filedialog.askopenfilename(
            title="Load waypoint CSV",
            filetypes=[("CSV files", "*.csv"), ("All", "*")])
        if not path:
            return
        try:
            WaypointPath.from_csv(path)  # validate before replacing the table
            with open(path) as f:
                content = f.read()
        except (OSError, ValueError) as e:
            messagebox.showerror("Load failed", str(e))
            return
        self.path_text.delete("1.0", tk.END)
        self.path_text.insert("1.0", content)

    def _save_path(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Save waypoint CSV", defaultextension=".csv",
            filetypes=[("CSV files", "*.csv")])
        if not path:
            return
        with open(path, "w") as f:
            f.write(self.path_text.get("1.0", tk.END).rstrip() + "\n")
        self.status_var.set(f"Saved path to {path}")

    # -- input parsing --------------------------------------------------------

    def _parse_float(self, var: tk.StringVar, name: str,
                     optional: bool = False) -> float | None:
        text = var.get().strip()
        if not text:
            if optional:
                return None
            raise ValueError(f"{name} is required")
        try:
            return float(text)
        except ValueError:
            raise ValueError(f"{name}: {text!r} is not a number") from None

    def _parse_waypoints(self) -> WaypointPath:
        rows = []
        for ln, line in enumerate(self.path_text.get("1.0", tk.END).splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fields = [p.strip() for p in line.split(",")]
            if fields[0].lower() in ("t", "time"):
                continue
            if len(fields) != 7:
                raise ValueError(
                    f"waypoint line {ln}: expected 7 comma-separated values "
                    f"(t, x, y, z, roll, pitch, yaw), got {len(fields)}")
            try:
                rows.append([float(p) for p in fields])
            except ValueError:
                raise ValueError(f"waypoint line {ln}: non-numeric value") from None
        if not rows:
            raise ValueError("the nozzle path needs at least one waypoint")
        return WaypointPath(rows)

    def _parse_part(self) -> Part:
        n_s = int(self._parse_float(self.n_axial_var, "Axial samples"))
        n_phi = int(self._parse_float(self.n_phi_var, "Azimuthal samples"))
        mode = self.part_mode.get()
        if mode == "cylinder":
            r = self._parse_float(self.radius_var, "Radius")
            h = self._parse_float(self.height_var, "Height")
            return Part.from_profile([(0.0, r), (h, r)], n_s=n_s, n_phi=n_phi,
                                     surface=self.surface_var.get())
        if mode == "profile":
            pts = []
            for ln, line in enumerate(
                    self.profile_text.get("1.0", tk.END).splitlines(), 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.replace(",", " ").split()
                if len(fields) != 2:
                    raise ValueError(f"profile line {ln}: expected 'z, r'")
                try:
                    pts.append((float(fields[0]), float(fields[1])))
                except ValueError:
                    raise ValueError(f"profile line {ln}: non-numeric value") from None
            if len(pts) < 2:
                raise ValueError("the Z/R profile needs at least two points")
            return Part.from_profile(pts, n_s=n_s, n_phi=n_phi,
                                     surface=self.surface_var.get())
        stl = self.stl_path_var.get().strip()
        if not stl:
            raise ValueError("choose an STL file")
        return Part.from_stl(stl, flip_normals=self.flip_var.get())

    # -- simulation -------------------------------------------------------------

    def _run(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        try:
            part = self._parse_part()
            path = self._parse_waypoints()
            nozzle = Nozzle(
                cone_half_angle=self._parse_float(self.cone_var, "Cone half-angle"),
                flow_rate=self._parse_float(self.flow_var, "Flow rate"),
                profile=self.profile_var.get(),
                efficiency=self._parse_float(self.eff_var, "Efficiency"),
            )
            rpm = self._parse_float(self.rpm_var, "Part speed")
            duration = self._parse_float(self.duration_var, "Duration",
                                         optional=True)
            if duration is None:
                duration = path.duration
            if duration <= 0:
                raise ValueError("duration must be positive (set Duration or "
                                 "give the last waypoint a time > 0)")
            dt = self._parse_float(self.dt_var, "Time step", optional=True)
        except ValueError as e:
            messagebox.showerror("Invalid input", str(e))
            return

        omega = rpm * 2 * np.pi / 60.0
        title = (f"cone {nozzle.cone_half_angle}° {nozzle.profile}, "
                 f"{rpm} rpm, {duration:g}s")

        self.run_btn.state(["disabled"])
        self.progress["value"] = 0.0
        self.status_var.set("Simulating…")

        def work() -> None:
            try:
                thickness = simulate(
                    part, nozzle, path, omega, duration, dt=dt, verbose=False,
                    progress=lambda f: self._queue.put(("progress", f)),
                )
                self._queue.put(("done", (part, thickness, title)))
            except Exception:
                self._queue.put(("error", traceback.format_exc()))

        self._worker = threading.Thread(target=work, daemon=True)
        self._worker.start()

    def _poll_queue(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == "progress":
                    self.progress["value"] = payload
                elif kind == "done":
                    part, thickness, title = payload
                    self._last_result = (part, thickness)
                    make_figure(part, thickness, title, figure=self.figure)
                    self.canvas.draw_idle()
                    coated = thickness > 0
                    vol = float(np.sum(thickness * part.areas))
                    mx = thickness[coated].max() if coated.any() else 0.0
                    self.status_var.set(
                        f"Done. Deposited volume {vol:.3f} mm³, "
                        f"coated {coated.mean() * 100:.1f}% of surface, "
                        f"max thickness {mx:.4g} mm.")
                    self.run_btn.state(["!disabled"])
                elif kind == "error":
                    self.status_var.set("Simulation failed.")
                    self.run_btn.state(["!disabled"])
                    messagebox.showerror("Simulation failed", payload)
        except queue.Empty:
            pass
        self.after(100, self._poll_queue)

    # -- outputs ---------------------------------------------------------------

    def _save_plot(self) -> None:
        if self._last_result is None:
            messagebox.showinfo("No results", "Run a simulation first.")
            return
        path = filedialog.asksaveasfilename(
            title="Save plot", defaultextension=".png",
            filetypes=[("PNG image", "*.png"), ("PDF", "*.pdf"), ("SVG", "*.svg")])
        if path:
            self.figure.savefig(path, dpi=150)
            self.status_var.set(f"Saved plot to {path}")

    def _export_csv(self) -> None:
        if self._last_result is None:
            messagebox.showinfo("No results", "Run a simulation first.")
            return
        path = filedialog.asksaveasfilename(
            title="Export thickness CSV", defaultextension=".csv",
            filetypes=[("CSV files", "*.csv")])
        if not path:
            return
        part, thickness = self._last_result
        data = np.column_stack([part.points, part.normals, part.areas, thickness])
        np.savetxt(path, data, delimiter=",", fmt="%.6g",
                   header="x,y,z,nx,ny,nz,area,thickness", comments="")
        self.status_var.set(f"Exported thickness to {path}")


def main() -> None:
    SprayGui().mainloop()


if __name__ == "__main__":
    main()
