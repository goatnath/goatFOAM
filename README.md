# LiqVid

LiqVid is a 3D Computational Fluid Dynamics (CFD) engine written entirely from scratch in Rust. It is heavily inspired by the architecture of [OpenFOAM](https://www.openfoam.com/), specifically the `icoFoam` solver and the PISO (Pressure Implicit with Splitting of Operator) algorithm. 

## Features (v0.1.0)
- **3D Structured Mesh Generation**: A custom grid system that maps 3D physical space into flat 1D arrays for high-performance memory access.
- **OpenFOAM-Style Data Structures**: Implements collocated `VolScalarField`, `VolVectorField`, and `SurfaceScalarField` types.
- **Finite Volume Calculus (FVC)**: 
  - Boundary-aware Gradient Operator (`fvc::grad`) using Gauss's Theorem.
  - Boundary-aware Divergence Operator (`fvc::div`).
- **Pressure-Velocity Coupling**: A custom iterative Jacobi solver for the Pressure Poisson equation ($\nabla^2 p = S$) to strictly enforce mass conservation.

## Getting Started

Make sure you have [Rust and Cargo](https://rustup.rs/) installed.

```bash
# Clone the repository
git clone https://github.com/goatnath/goatFOAM.git
cd goatFOAM

# Run the simulation
cargo run
```

## Current Simulation Demo
Running the engine currently executes a "Mass Conservation" stress test. A massive, non-physical velocity spike is injected into the center of the 3D fluid domain. The PISO algorithm detects the divergence, solves the Pressure Poisson equation, and mathematically pushes the surrounding fluid outward to return the divergence to zero.
