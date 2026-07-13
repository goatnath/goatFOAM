use axum::{
    Json, Router,
    response::sse::{Event, Sse},
    routing::post,
};
use futures::stream::Stream;
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::cors::CorsLayer;

use crate::fields::{VolScalarField, VolVectorField};
use crate::mesh::Mesh;
mod fields;
mod fvc;
mod geometry;
mod mesh;
mod piso;

#[derive(Deserialize, Debug)]
pub struct Vector3Def {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Deserialize, Debug)]
pub struct InletRequest {
    pub id: usize,
    pub position: Vector3Def,
    pub velocity: Vector3Def,
}

#[derive(Deserialize, Debug)]
pub struct SimulationRequest {
    pub kinematicViscosity: f64,
    pub density: f64,
    pub inlets: Vec<InletRequest>,
    pub stl_base64: Option<String>,
}

#[derive(Serialize)]
pub struct SimulationResponse {
    pub status: String,
    pub message: String,
}

#[tokio::main]
async fn main() {
    println!("Initializing LiqVid Physics API...");

    // Allow the React frontend to make requests to this backend
    let cors = CorsLayer::permissive();

    let app = Router::new()
        .route("/simulate", post(run_simulation))
        .layer(cors);

    println!("Server listening on http://127.0.0.1:3000");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .unwrap();
    axum::serve(listener, app).await.unwrap();
}

// This function is triggered whenever the React UI sends a request
async fn run_simulation(
    Json(payload): Json<SimulationRequest>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    println!("\n--- NEW SIMULATION REQUEST ---");
    println!("Density: {}", payload.density);
    println!("Viscosity: {}", payload.kinematicViscosity);
    println!("Active Inlets: {}", payload.inlets.len());

    for inlet in &payload.inlets {
        println!(
            " - Inlet #{}: Position({:?}) Velocity({:?})",
            inlet.id, inlet.position, inlet.velocity
        );
    }

    let (tx, rx) = mpsc::channel(100);

    tokio::spawn(async move {
        // Send initial message
        let _ = tx
            .send(Ok(
                Event::default().data("Initializing mesh and boundaries...")
            ))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let nx = 20;
        let ny = 20;
        let nz = 20;

        let mesh = Mesh::new(nx, ny, nz, 100.0, 100.0, 100.0);
        let mut p = VolScalarField::new(&mesh, 0.0);
        let mut u = VolVectorField::new(&mesh, Vector3::new(0.0, 0.0, 0.0));
        let dt = 0.01;

        let mut geom = geometry::Geometry::new(&mesh);

        if let Some(ref base64_str) = payload.stl_base64 {
            let _ = tx.send(Ok(Event::default().data("Voxelizing STL Geometry... (this may take a few seconds)"))).await;
            use base64::{Engine as _, engine::general_purpose};
            if let Ok(bytes) = general_purpose::STANDARD.decode(base64_str) {
                if let Err(e) = geom.load_stl_from_bytes(&mesh, &bytes) {
                    println!("Error loading STL: {}", e);
                } else {
                    let _ = tx.send(Ok(Event::default().data("STL successfully loaded into CFD Mesh!"))).await;
                }
            }
        }

        for inlet in &payload.inlets {
            let shifted_x = inlet.position.x + 50.0;
            let shifted_y = inlet.position.y + 50.0;
            let shifted_z = inlet.position.z + 50.0;

            let i = ((shifted_x / mesh.dx).floor() as usize).clamp(0, nx - 1);
            let j = ((shifted_y / mesh.dy).floor() as usize).clamp(0, ny - 1);
            let k = ((shifted_z / mesh.dz).floor() as usize).clamp(0, nz - 1);

            let idx = mesh.cell_idx(i, j, k);
            u.internal_field[idx] =
                Vector3::new(inlet.velocity.x, inlet.velocity.y, inlet.velocity.z);

            let _ = tx
                .send(Ok(Event::default().data(format!(
                    "Injected velocity spike at cell ({}, {}, {})",
                    i, j, k
                ))))
                .await;
        }
        let _ = tx
            .send(Ok(
                Event::default().data("Starting PISO Mass Conservation Loop....")
            ))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        for step in 1..=50 {
            let nu = payload.kinematicViscosity;
            let laplacian_u = fvc::laplacian_vector(&u, &mesh);
            let convection_u = fvc::convect(&u, &mesh);

            for i in 0..mesh.num_cells() {
                u.internal_field[i] += (laplacian_u.internal_field[i] * nu - convection_u.internal_field[i]) * dt;
            }

            // --- NO SLIP BOUNDARY CONDITION ---
            // If the fluid is inside a solid wall, it stops moving.
            for i in 0..mesh.num_cells() {
                if geom.is_solid[i] {
                    u.internal_field[i] = Vector3::new(0.0, 0.0, 0.0);
                }
            }

            let div_u = fvc::div(&u, &mesh);

            let mut source = VolScalarField::new(&mesh, 0.0);
            let mut max_div_u = 0.0_f64;

            for i in 0..mesh.num_cells() {
                let div_val = div_u.internal_field[i];
                source.internal_field[i] = div_val / dt;

                if div_val.abs() > max_div_u {
                    max_div_u = div_val.abs();
                }
            }
            piso::solve_pressure_poisson(&mut p, &mesh, &source, 20);

            let grad_p = fvc::grad(&p, &mesh);

            for i in 0..mesh.num_cells() {
                u.internal_field[i] -= grad_p.internal_field[i] * dt;
            }
            
            // --- NO SLIP BOUNDARY CONDITION (AGAIN) ---
            // The pressure gradient might have accidentally pushed fluid into the wall,
            // so we strictly enforce it again here.
            for i in 0..mesh.num_cells() {
                if geom.is_solid[i] {
                    u.internal_field[i] = Vector3::new(0.0, 0.0, 0.0);
                }
            }

            let msg = format!("Time Step {:02}: Max Divergence = {:.6}", step, max_div_u);
            if tx.send(Ok(Event::default().data(msg))).await.is_err() {
                println!("Client disconnected. Halting simulation early.");
                break;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        }

        let _ = tx
            .send(Ok(Event::default().data(
                "Simulation completed successfully! Divergence minimised",
            )))
            .await;

        // --- NEW: SEND THE VISUALIZATION SLICE ---
        let _ = tx.send(Ok(Event::default().data("Generating 3D Heatmap Slice..."))).await;
        
        let mut slice_data = Vec::new();
        let k = nz / 2; // Slice right down the middle of the Z axis

        for i in 0..mesh.nx {
            for j in 0..mesh.ny {
                let idx = mesh.cell_idx(i, j, k);
                let vel = u.internal_field[idx];
                
                // Calculate the magnitude (speed) of the vector
                let mag = (vel.x * vel.x + vel.y * vel.y + vel.z * vel.z).sqrt();
                
                slice_data.push(serde_json::json!({
                    "x": (i as f64 + 0.5) * mesh.dx - 50.0,
                    "y": (j as f64 + 0.5) * mesh.dy - 50.0,
                    "z": 0.0, // The UI draws this flat on the Z=0 plane
                    "mag": mag
                }));
            }
        }

        // Format as JSON and send to React with the [SLICE] prefix
        if let Ok(slice_json) = serde_json::to_string(&slice_data) {
            let msg = format!("[SLICE]{}", slice_json);
            let _ = tx.send(Ok(Event::default().data(msg))).await;
        }

        // The stream ends when the tx goes out of scope and is dropped.
    });

    Sse::new(ReceiverStream::new(rx))
}
