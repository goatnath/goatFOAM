# LiqVid

LiqVid is a 3D Computational Fluid Dynamics (CFD) engine written entirely from scratch in Rust, paired with a dynamic React/Three.js frontend visualizer. 

It is heavily inspired by the architecture of [OpenFOAM](https://www.openfoam.com/), specifically the `icoFoam` solver and the PISO (Pressure Implicit with Splitting of Operator) algorithm. 

## Core Physics Features
- **3D Structured Mesh Generation**: A custom grid system that maps 3D physical space into flat 1D arrays for high-performance memory access.
- **Navier-Stokes Solver**: A full implementation of the PISO algorithm for incompressible flow.
  - **Inertia (Convection)**: Solves $(\mathbf{U} \cdot \nabla) \mathbf{U}$ to transport momentum forward.
  - **Viscous Diffusion (Laplacian)**: Simulates fluid friction using the kinematic viscosity ($\nu \nabla^2 \mathbf{U}$).
  - **Mass Conservation**: A custom iterative Jacobi solver for the Pressure Poisson equation ($\nabla^2 p = S$) to strictly enforce divergence-free flow.
- **STL Geometry & Voxelization**: Dynamically loads 3D `.stl` CAD models, uses the Möller–Trumbore ray-casting algorithm to voxelize the solid, and mathematically enforces No-Slip Boundary Conditions ($\mathbf{U} = 0$) inside the geometry.

## UI & Visualizer Features
- **React + Three.js Frontend**: A fully interactive 3D web application to configure and view the simulation.
- **Interactive Boundary Conditions**: Double-click anywhere on your 3D model to dynamically inject flow inlets.
- **Real-Time Heatmap Streaming**: The Rust backend extracts 2D cross-sections of the 3D velocity field and streams them via Server-Sent Events (SSE) to the browser.
- **Dynamic Opacity**: The heatmap automatically maps fluid velocity to HSL colors and opacity, allowing you to see high-speed fluid jets crashing into and flowing around your STL models in real time.

## Getting Started

Make sure you have [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/) installed.

```bash
# Clone the repository
git clone https://github.com/goatnath/LiqVid.git
cd LiqVid

# Start the Rust CFD Engine (Backend)
cargo run

# In a new terminal, start the React Visualizer (Frontend)
cd ui
npm install
npm run dev
```

Open your browser to the local Vite URL (usually `http://localhost:5173`). Upload a `.stl` file, click to place an inlet, and hit "Run Simulation" to watch the physics unfold!
