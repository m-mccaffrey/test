#!/usr/bin/env python3
"""Spray deposition thickness simulator for rotating, rotationally symmetric parts.

Physical model
--------------
A nozzle emits material inside a cone. The volumetric flux carried per unit
solid angle falls off with angle ``alpha`` from the spray axis according to a
selectable intensity profile (Gaussian, cosine-power, or uniform), truncated
at the cone half-angle, and normalized so the integral over the cone equals
the nozzle flow rate ``Q`` (times a transfer efficiency).

The deposition rate on a surface element at distance ``d`` whose normal makes
an angle-of-incidence AOI with the incoming spray ray is

    dh/dt = Q * eta * f(alpha) * cos(AOI) / d**2      [length / time]

which is the exact solid-angle projection of the element as seen from the
nozzle. Thickness is accumulated by explicit time stepping while the part
rotates at constant angular velocity ``omega`` about the z axis and the
nozzle follows an arbitrary 6-DOF path (x, y, z, roll, pitch, yaw as
functions of time). Rotation is handled by transforming the nozzle into the
part frame each step, so the surface mesh stays fixed.

Part geometry is either
  * a Z/R meridian profile (list of (z, r) pairs) revolved about z, or
  * an STL mesh (binary or ASCII; loaded with a built-in parser).

Limitations: no shadowing/occlusion test (fine for a nozzle inside a convex
inner surface, e.g. coating a cylinder bore from the axis), no overspray
bounce, no rarefaction — pure line-of-sight geometric flux.

Conventions
-----------
Units are consistent but arbitrary; the examples use mm, seconds, mm^3/s.
The part axis is +z. The nozzle spray axis in its body frame is +x, rotated
by intrinsic Z-Y-X (yaw, pitch, roll). With zero angles the nozzle sprays
radially outward along +x, hitting an inner cylinder wall at AOI = 0; a
pitch of ``a`` degrees tilts the axis toward -z and produces AOI = a on a
cylindrical inner wall.

Run ``python spray_sim.py --help`` for the built-in cylinder example.
"""

from __future__ import annotations

import argparse
import struct
from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np

Pose = tuple[float, float, float, float, float, float]  # x y z roll pitch yaw (rad)

NOZZLE_AXIS = np.array([1.0, 0.0, 0.0])  # spray direction in nozzle body frame


# --------------------------------------------------------------------------
# Rotations
# --------------------------------------------------------------------------

def rpy_matrix(roll: float, pitch: float, yaw: float) -> np.ndarray:
    """Rotation matrix for intrinsic Z-Y-X (yaw, pitch, roll), angles in rad."""
    cr, sr = np.cos(roll), np.sin(roll)
    cp, sp = np.cos(pitch), np.sin(pitch)
    cy, sy = np.cos(yaw), np.sin(yaw)
    rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]])
    ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    return rz @ ry @ rx


def rot_z(theta: float) -> np.ndarray:
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


# --------------------------------------------------------------------------
# Nozzle
# --------------------------------------------------------------------------

@dataclass
class Nozzle:
    """Spray nozzle with a conical plume.

    cone_half_angle : full cone half-angle in degrees (spray cut off beyond it)
    flow_rate       : volumetric flow rate of deposited material (e.g. mm^3/s)
    profile         : 'gaussian' (sigma = half-angle/2), 'cosine' (cos^m,
                      zero at the cone edge), or 'uniform'
    cosine_power    : exponent m for the 'cosine' profile
    efficiency      : transfer efficiency multiplier (0..1)
    """

    cone_half_angle: float = 15.0
    flow_rate: float = 10.0
    profile: str = "gaussian"
    cosine_power: float = 2.0
    efficiency: float = 1.0
    _norm: float = field(init=False, repr=False, default=0.0)

    def __post_init__(self) -> None:
        self._cutoff = np.deg2rad(self.cone_half_angle)
        # Normalize so  integral over the cone of f(alpha) dOmega == 1.
        a = np.linspace(0.0, self._cutoff, 2000)
        integral = np.trapezoid(self._shape(a) * 2 * np.pi * np.sin(a), a)
        self._norm = 1.0 / integral

    def _shape(self, alpha: np.ndarray) -> np.ndarray:
        if self.profile == "gaussian":
            sigma = self._cutoff / 2.0
            return np.exp(-0.5 * (alpha / sigma) ** 2)
        if self.profile == "cosine":
            # Falls smoothly to zero exactly at the cone edge.
            return np.cos(alpha * (np.pi / 2) / self._cutoff) ** self.cosine_power
        if self.profile == "uniform":
            return np.ones_like(alpha)
        raise ValueError(f"unknown profile {self.profile!r}")

    def intensity(self, alpha: np.ndarray) -> np.ndarray:
        """Flow per unit solid angle at off-axis angle alpha (rad)."""
        out = np.where(alpha <= self._cutoff, self._shape(alpha), 0.0)
        return self.flow_rate * self.efficiency * self._norm * out


# --------------------------------------------------------------------------
# Part geometry
# --------------------------------------------------------------------------

@dataclass
class Part:
    """Deposition surface as point samples with normals and areas.

    points  : (N, 3) sample positions in the part frame (part axis = z)
    normals : (N, 3) unit normals pointing toward the spray side
    areas   : (N,) area represented by each sample
    grid    : for profile parts, (n_s, n_phi, s_coords, phi_coords, z_coords,
              r_coords) enabling structured (unrolled) plotting; None for STL
    """

    points: np.ndarray
    normals: np.ndarray
    areas: np.ndarray
    grid: tuple | None = None

    # -- construction ------------------------------------------------------

    @classmethod
    def from_profile(
        cls,
        zr: Sequence[tuple[float, float]],
        n_s: int = 120,
        n_phi: int = 180,
        surface: str = "inner",
    ) -> "Part":
        """Revolve a meridian profile of (z, r) pairs about the z axis.

        surface='inner' points the normals toward the axis (coating a bore);
        'outer' points them away from the axis.
        """
        zr_arr = np.asarray(zr, dtype=float)
        if zr_arr.ndim != 2 or zr_arr.shape[1] != 2:
            raise ValueError("zr must be a sequence of (z, r) pairs")
        z_in, r_in = zr_arr[:, 0], zr_arr[:, 1]
        if np.any(r_in < 0):
            raise ValueError("radii must be non-negative")

        # Resample the profile uniformly by arc length.
        seg = np.hypot(np.diff(z_in), np.diff(r_in))
        s_in = np.concatenate([[0.0], np.cumsum(seg)])
        if s_in[-1] <= 0:
            raise ValueError("profile has zero length")
        s = np.linspace(0.0, s_in[-1], n_s)
        z = np.interp(s, s_in, z_in)
        r = np.interp(s, s_in, r_in)

        # Meridian tangent and in-plane normal. (dz, -dr) points away from
        # the axis for a profile traversed with increasing z.
        dz = np.gradient(z, s)
        dr = np.gradient(r, s)
        tn = np.hypot(dz, dr)
        tn[tn == 0] = 1.0
        n_r_merid = dz / tn   # radial component of outward normal
        n_z_merid = -dr / tn  # axial component of outward normal
        if surface == "inner":
            n_r_merid, n_z_merid = -n_r_merid, -n_z_merid
        elif surface != "outer":
            raise ValueError("surface must be 'inner' or 'outer'")

        phi = np.linspace(0.0, 2 * np.pi, n_phi, endpoint=False)
        cphi, sphi = np.cos(phi), np.sin(phi)

        # Grids shaped (n_s, n_phi).
        x = r[:, None] * cphi[None, :]
        y = r[:, None] * sphi[None, :]
        zz = np.broadcast_to(z[:, None], x.shape)
        nx = n_r_merid[:, None] * cphi[None, :]
        ny = n_r_merid[:, None] * sphi[None, :]
        nz = np.broadcast_to(n_z_merid[:, None], x.shape)

        ds = s[-1] / max(n_s - 1, 1)
        dphi = 2 * np.pi / n_phi
        areas = np.broadcast_to((r * ds * dphi)[:, None], x.shape)

        points = np.stack([x, y, zz], axis=-1).reshape(-1, 3)
        normals = np.stack([nx, ny, nz], axis=-1).reshape(-1, 3)
        return cls(
            points=points,
            normals=normals,
            areas=areas.reshape(-1).copy(),
            grid=(n_s, n_phi, s, phi, z, r),
        )

    @classmethod
    def from_stl(cls, path: str, flip_normals: bool = False) -> "Part":
        """Load an STL mesh; each triangle becomes one sample at its centroid.

        Normals come from the right-hand rule on the vertex order. Use
        flip_normals=True if the mesh winding points them away from the
        spray (e.g. an outward-wound shell being coated on the inside).
        """
        tris = _load_stl(path)  # (n, 3, 3)
        centroids = tris.mean(axis=1)
        e1 = tris[:, 1] - tris[:, 0]
        e2 = tris[:, 2] - tris[:, 0]
        cross = np.cross(e1, e2)
        cn = np.linalg.norm(cross, axis=1)
        keep = cn > 1e-12
        tris, centroids, cross, cn = tris[keep], centroids[keep], cross[keep], cn[keep]
        normals = cross / cn[:, None]
        if flip_normals:
            normals = -normals
        return cls(points=centroids, normals=normals, areas=0.5 * cn, grid=None)


def _load_stl(path: str) -> np.ndarray:
    """Minimal STL reader (binary and ASCII). Returns (n_tri, 3, 3) vertices."""
    with open(path, "rb") as f:
        raw = f.read()
    # ASCII files start with 'solid' AND contain 'facet'; some binary files
    # also start with 'solid', so check the size math too.
    if raw[:5].lower() == b"solid" and b"facet" in raw[:1024].lower():
        verts = []
        for line in raw.decode("ascii", errors="replace").splitlines():
            parts = line.split()
            if len(parts) == 4 and parts[0].lower() == "vertex":
                verts.append([float(v) for v in parts[1:4]])
        arr = np.asarray(verts, dtype=float)
        if arr.size == 0 or len(arr) % 3:
            raise ValueError(f"malformed ASCII STL: {path}")
        return arr.reshape(-1, 3, 3)
    if len(raw) < 84:
        raise ValueError(f"file too short to be binary STL: {path}")
    (n_tri,) = struct.unpack_from("<I", raw, 80)
    expected = 84 + n_tri * 50
    if len(raw) < expected:
        raise ValueError(f"binary STL truncated: {path}")
    rec = np.frombuffer(raw, dtype=np.uint8, count=n_tri * 50, offset=84)
    rec = rec.reshape(n_tri, 50)[:, 12:48].copy()  # skip normal, keep 9 floats
    return rec.view("<f4").astype(float).reshape(n_tri, 3, 3)


# --------------------------------------------------------------------------
# Nozzle paths
# --------------------------------------------------------------------------

PathFn = Callable[[float], Pose]


def linear_axial_path(
    z_start: float,
    z_end: float,
    duration: float,
    aoi_deg: float = 45.0,
    x: float = 0.0,
    y: float = 0.0,
) -> PathFn:
    """Nozzle on (or near) the part axis, traversing z_start -> z_end.

    The spray axis points radially outward (+x) pitched by aoi_deg toward -z,
    so on a cylindrical inner wall the angle of incidence equals aoi_deg.
    """
    pitch = np.deg2rad(aoi_deg)

    def path(t: float) -> Pose:
        frac = np.clip(t / duration, 0.0, 1.0)
        return (x, y, z_start + frac * (z_end - z_start), 0.0, pitch, 0.0)

    return path


class WaypointPath:
    """Piecewise-linear 6-DOF nozzle trajectory from time-keyed waypoints.

    Each waypoint is (t, x, y, z, roll, pitch, yaw). Angles are degrees by
    default (set angles_in_degrees=False for radians). Between waypoints each
    axis is interpolated linearly in time; outside the listed time range the
    pose is clamped to the first/last waypoint. Calling the object with a
    time returns the Pose (angles in radians) expected by simulate().
    """

    COLUMNS = ("t", "x", "y", "z", "roll", "pitch", "yaw")

    def __init__(
        self,
        waypoints: Sequence[Sequence[float]],
        angles_in_degrees: bool = True,
    ) -> None:
        wp = np.asarray(waypoints, dtype=float)
        if wp.ndim != 2 or wp.shape[1] != 7:
            raise ValueError(
                "waypoints must be rows of (t, x, y, z, roll, pitch, yaw)"
            )
        if len(wp) < 1:
            raise ValueError("need at least one waypoint")
        wp = wp[np.argsort(wp[:, 0], kind="stable")]
        if np.any(np.diff(wp[:, 0]) < 0):
            raise ValueError("waypoint times must not decrease")
        if angles_in_degrees:
            wp = wp.copy()
            wp[:, 4:7] = np.deg2rad(wp[:, 4:7])
        self._t = wp[:, 0]
        self._axes = wp[:, 1:7]

    @property
    def duration(self) -> float:
        """Time of the last waypoint."""
        return float(self._t[-1])

    def __call__(self, t: float) -> Pose:
        # np.interp clamps to the end values outside the time range.
        return tuple(
            np.interp(t, self._t, self._axes[:, k]) for k in range(6)
        )

    @classmethod
    def from_csv(cls, path: str, angles_in_degrees: bool = True) -> "WaypointPath":
        """Load waypoints from CSV lines 't,x,y,z,roll,pitch,yaw'.

        Blank lines and lines starting with '#' are ignored; a header line
        containing the column names is ignored too.
        """
        rows = []
        with open(path) as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = [p.strip() for p in line.split(",")]
                if fields[0].lower() in ("t", "time"):
                    continue  # header
                if len(fields) != 7:
                    raise ValueError(f"{path}:{ln}: expected 7 fields, got {len(fields)}")
                try:
                    rows.append([float(p) for p in fields])
                except ValueError as e:
                    raise ValueError(f"{path}:{ln}: {e}") from None
        return cls(rows, angles_in_degrees=angles_in_degrees)


# --------------------------------------------------------------------------
# Simulation
# --------------------------------------------------------------------------

def simulate(
    part: Part,
    nozzle: Nozzle,
    path: PathFn,
    omega: float,
    t_end: float,
    dt: float | None = None,
    max_deg_per_step: float = 4.0,
    verbose: bool = True,
    progress: Callable[[float], None] | None = None,
) -> np.ndarray:
    """Accumulate deposition thickness over [0, t_end].

    omega    : part angular velocity about +z (rad/s, constant)
    dt       : time step; default limits part rotation to max_deg_per_step
               per step (and uses <= 5000 steps only if that is coarser).
    progress : optional callback receiving completion fraction in [0, 1],
               called about 100 times over the run (e.g. for a GUI bar).
    Returns thickness per surface sample, same units as lengths.
    """
    if dt is None:
        if omega != 0.0:
            dt = np.deg2rad(max_deg_per_step) / abs(omega)
        else:
            dt = t_end / 2000
    n_steps = max(int(np.ceil(t_end / dt)), 1)
    dt = t_end / n_steps

    pts = part.points
    nrm = part.normals
    thickness = np.zeros(len(pts))

    for i in range(n_steps):
        t = (i + 0.5) * dt  # midpoint rule
        x0, y0, z0, roll, pitch, yaw = path(t)
        p_world = np.array([x0, y0, z0])
        d_world = rpy_matrix(roll, pitch, yaw) @ NOZZLE_AXIS

        # Part has rotated by omega*t; express the nozzle in the part frame.
        r_inv = rot_z(-omega * t)
        p = r_inv @ p_world
        d = r_inv @ d_world

        v = pts - p
        dist = np.linalg.norm(v, axis=1)
        ok = dist > 1e-9
        vhat = np.zeros_like(v)
        vhat[ok] = v[ok] / dist[ok, None]

        cos_alpha = np.clip(vhat @ d, -1.0, 1.0)
        alpha = np.arccos(cos_alpha)
        cos_inc = -np.einsum("ij,ij->i", vhat, nrm)  # cos(AOI), >0 = facing

        rate = np.zeros(len(pts))
        hit = ok & (cos_inc > 0.0) & (alpha <= nozzle._cutoff)
        if np.any(hit):
            rate[hit] = (
                nozzle.intensity(alpha[hit]) * cos_inc[hit] / dist[hit] ** 2
            )
        thickness += rate * dt

        if verbose and (i % max(n_steps // 10, 1) == 0 or i == n_steps - 1):
            print(f"  step {i + 1:>6}/{n_steps}  t={t:8.3f}s")
        if progress is not None and (
            i % max(n_steps // 100, 1) == 0 or i == n_steps - 1
        ):
            progress((i + 1) / n_steps)

    return thickness


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def make_figure(part: Part, thickness: np.ndarray, title: str, figure=None):
    """Draw the results into a matplotlib Figure and return it.

    Pass an existing Figure (e.g. one embedded in a GUI canvas) to reuse it;
    otherwise a new one is created via pyplot.
    """
    if figure is None:
        import matplotlib.pyplot as plt

        fig = plt.figure(figsize=(12, 4.5))
    else:
        fig = figure
        fig.clear()

    if part.grid is not None:
        n_s, n_phi, s, phi, z, r = part.grid
        th = thickness.reshape(n_s, n_phi)
        ax1, ax2 = fig.subplots(
            1, 2, gridspec_kw={"width_ratios": [1.6, 1.0]}
        )
        phi_deg = np.rad2deg(phi)
        mesh = ax1.pcolormesh(phi_deg, z, th, cmap="viridis", shading="nearest")
        fig.colorbar(mesh, ax=ax1, label="thickness")
        ax1.set_xlabel("azimuth on part (deg)")
        ax1.set_ylabel("z along part axis")
        ax1.set_title("Deposited thickness (surface unrolled)")

        mean_th = th.mean(axis=1)
        ax2.fill_betweenx(
            z, th.min(axis=1), th.max(axis=1),
            alpha=0.25, color="#4c78a8", lw=0, label="min–max over azimuth",
        )
        ax2.plot(mean_th, z, color="#4c78a8", lw=2, label="azimuthal mean")
        ax2.set_xlabel("thickness")
        ax2.set_ylabel("z along part axis")
        ax2.set_title("Axial thickness profile")
        ax2.legend(loc="best", frameon=False)
        ax2.grid(alpha=0.25, lw=0.5)
    else:
        az = np.rad2deg(np.arctan2(part.points[:, 1], part.points[:, 0]))
        ax1 = fig.subplots()
        sc = ax1.scatter(
            az, part.points[:, 2], c=thickness, s=6, cmap="viridis", lw=0
        )
        fig.colorbar(sc, ax=ax1, label="thickness")
        ax1.set_xlabel("azimuth on part (deg)")
        ax1.set_ylabel("z along part axis")
        ax1.set_title("Deposited thickness per STL facet (unrolled)")

    fig.suptitle(title)
    fig.tight_layout()
    return fig


def plot_results(part: Part, thickness: np.ndarray, out_png: str, title: str) -> None:
    import matplotlib

    matplotlib.use("Agg")

    fig = make_figure(part, thickness, title)
    fig.savefig(out_png, dpi=150)
    print(f"wrote {out_png}")


def summarize(thickness: np.ndarray, areas: np.ndarray) -> None:
    coated = thickness > 0
    vol = float(np.sum(thickness * areas))
    print(f"deposited volume     : {vol:.3f}")
    if np.any(coated):
        print(f"coated area fraction : {coated.mean() * 100:.1f}%")
        print(f"thickness min/mean/max on coated area: "
              f"{thickness[coated].min():.4g} / "
              f"{thickness[coated].mean():.4g} / "
              f"{thickness[coated].max():.4g}")


# --------------------------------------------------------------------------
# Example / CLI
# --------------------------------------------------------------------------

def cylinder_profile(radius: float, height: float) -> list[tuple[float, float]]:
    return [(0.0, radius), (height, radius)]


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Spray deposition onto a rotating, rotationally symmetric part. "
        "Default example: nozzle traversing the axis of a cylinder, spraying "
        "the inner wall at a fixed AOI."
    )
    g = ap.add_argument_group("part")
    g.add_argument("--stl", help="STL file for the part (overrides the cylinder)")
    g.add_argument("--flip-normals", action="store_true",
                   help="flip STL normals (coat the other side)")
    g.add_argument("--radius", type=float, default=50.0,
                   help="cylinder inner radius [mm] (default 50)")
    g.add_argument("--height", type=float, default=200.0,
                   help="cylinder height [mm] (default 200)")
    g.add_argument("--n-axial", type=int, default=120, help="axial samples")
    g.add_argument("--n-phi", type=int, default=180, help="azimuthal samples")

    g = ap.add_argument_group("nozzle / process")
    g.add_argument("--cone-angle", type=float, default=15.0,
                   help="cone half-angle [deg] (default 15)")
    g.add_argument("--profile", choices=["gaussian", "cosine", "uniform"],
                   default="gaussian", help="cone intensity profile")
    g.add_argument("--flow-rate", type=float, default=20.0,
                   help="volumetric flow rate [mm^3/s] (default 20)")
    g.add_argument("--aoi", type=float, default=45.0,
                   help="target angle of incidence on the wall [deg] (default 45)")
    g.add_argument("--rpm", type=float, default=120.0,
                   help="part rotation speed [rev/min] (default 120)")
    g.add_argument("--z-start", type=float, default=None,
                   help="nozzle start z (default 10%% of height)")
    g.add_argument("--z-end", type=float, default=None,
                   help="nozzle end z (default 90%% of height)")
    g.add_argument("--path-file",
                   help="CSV of nozzle waypoints 't,x,y,z,roll,pitch,yaw' "
                        "(angles in deg), linearly interpolated in time; "
                        "overrides the axial traverse and --aoi")
    g.add_argument("--duration", type=float, default=None,
                   help="simulated time [s] (default: 20, or the last "
                        "waypoint time with --path-file)")
    g.add_argument("--dt", type=float, default=None,
                   help="time step [s] (default: 4 deg of rotation per step)")
    g.add_argument("-o", "--out", default="deposition.png", help="output plot")

    args = ap.parse_args()

    if args.stl:
        part = Part.from_stl(args.stl, flip_normals=args.flip_normals)
        desc = f"STL {args.stl} ({len(part.points)} facets)"
    else:
        part = Part.from_profile(
            cylinder_profile(args.radius, args.height),
            n_s=args.n_axial, n_phi=args.n_phi, surface="inner",
        )
        desc = f"cylinder r={args.radius} h={args.height} (inner wall)"

    nozzle = Nozzle(
        cone_half_angle=args.cone_angle,
        flow_rate=args.flow_rate,
        profile=args.profile,
    )

    if args.path_file:
        path = WaypointPath.from_csv(args.path_file)
        duration = args.duration if args.duration is not None else path.duration
        path_desc = f"waypoints from {args.path_file} ({duration}s)"
        title = (f"path {args.path_file}, cone {args.cone_angle} deg, "
                 f"{args.rpm} rpm, {duration}s")
    else:
        duration = args.duration if args.duration is not None else 20.0
        z_start = args.z_start if args.z_start is not None else 0.10 * args.height
        z_end = args.z_end if args.z_end is not None else 0.90 * args.height
        path = linear_axial_path(z_start, z_end, duration, aoi_deg=args.aoi)
        path_desc = (f"axis traverse z {z_start:.1f} -> {z_end:.1f} mm "
                     f"over {duration}s")
        title = (f"AOI {args.aoi} deg, cone {args.cone_angle} deg, "
                 f"{args.rpm} rpm, {duration}s traverse")
    omega = args.rpm * 2 * np.pi / 60.0

    print(f"part   : {desc}")
    print(f"nozzle : half-angle {args.cone_angle} deg, {args.profile}, "
          f"Q={args.flow_rate} mm^3/s")
    print(f"path   : {path_desc}, part at {args.rpm} rpm")

    thickness = simulate(part, nozzle, path, omega, duration, dt=args.dt)
    summarize(thickness, part.areas)
    plot_results(part, thickness, args.out, title)


if __name__ == "__main__":
    main()
