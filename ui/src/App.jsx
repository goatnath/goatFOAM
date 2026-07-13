import { useState, useRef } from 'react';
import { Upload, Box, Plus, Trash2, Terminal } from 'lucide-react';
import { Canvas, useLoader } from '@react-three/fiber';
import { OrbitControls, Center, Environment } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader';

// This component handles loading and displaying the STL geometry
function StlModel({ fileUrl, onPointSelect, onDoubleClick }) {
  const geometry = useLoader(STLLoader, fileUrl);
  return (
    <mesh 
      geometry={geometry} 
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointSelect(e.point);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick(e.point);
      }}
    >
      <meshStandardMaterial color="#333333" wireframe={false} roughness={0.5} metalness={0.2} />
    </mesh>
  );
}

function App() {
  const fileInputRef = useRef(null);
  const [stlFileUrl, setStlFileUrl] = useState(null);

  const [fluidProperties, setFluidProperties] = useState({
    kinematicViscosity: 0.00001,
    density: 1000.0,
  });

  // Array of inlets
  const [inlets, setInlets] = useState([]);
  
  // Tracks which inlet is currently waiting for a mouse click on the 3D model
  const [placingInletId, setPlacingInletId] = useState(null);
  const [nextInletId, setNextInletId] = useState(1);
  
  // Tracks when a user double clicks and needs to be prompted for velocity
  const [velocityPrompt, setVelocityPrompt] = useState(null);

  // Live simulation logs
  const [logs, setLogs] = useState([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const logsEndRef = useRef(null);
  
  // CFD Heatmap slice data
  const [sliceData, setSliceData] = useState(null);

  const [stlBase64, setStlBase64] = useState(null);

  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setStlFileUrl(url);
      
      // Read the raw file to send to the Rust backend
      const reader = new FileReader();
      reader.onload = (e) => {
        // e.target.result is a data URL like "data:model/stl;base64,AAAA..."
        const base64 = e.target.result.split(',')[1];
        setStlBase64(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePointSelect = (point) => {
    if (placingInletId === null) return;
    setInlets(prev => prev.map(inlet => {
      if (inlet.id === placingInletId) {
        return {
          ...inlet,
          position: {
            x: parseFloat(point.x.toFixed(2)),
            y: parseFloat(point.y.toFixed(2)),
            z: parseFloat(point.z.toFixed(2))
          }
        };
      }
      return inlet;
    }));
    // Instantly lock position so user doesn't have to move mouse back to click "Fix"
    setPlacingInletId(null);
  };

  const handleDoubleClick = (point) => {
    // Open the velocity prompt modal instead of instantly placing with a default velocity
    setVelocityPrompt({
      point: {
        x: parseFloat(point.x.toFixed(2)),
        y: parseFloat(point.y.toFixed(2)),
        z: parseFloat(point.z.toFixed(2))
      },
      vx: 0,
      vy: 0,
      vz: 0
    });
  };

  const submitVelocityPrompt = () => {
    const newInlet = {
      id: nextInletId,
      position: velocityPrompt.point,
      velocity: { x: velocityPrompt.vx, y: velocityPrompt.vy, z: velocityPrompt.vz }
    };
    setInlets(prev => [...prev, newInlet]);
    setNextInletId(prev => prev + 1);
    setVelocityPrompt(null);
  };

  const updateInletVector = (id, type, field, value) => {
    setInlets(prev => prev.map(inlet => {
      if (inlet.id === id) {
        return {
          ...inlet,
          [type]: {
            ...inlet[type],
            [field]: parseFloat(value) || 0
          }
        };
      }
      return inlet;
    }));
  };

  const addInlet = () => {
    const newInlet = {
      id: nextInletId,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 }
    };
    setInlets([...inlets, newInlet]);
    setPlacingInletId(nextInletId); // Automatically enter placement mode for the new inlet
    setNextInletId(nextInletId + 1);
  };

  const removeInlet = (id) => {
    const newInlets = inlets.filter(i => i.id !== id);
    setInlets(newInlets);
    if (placingInletId === id) {
      setPlacingInletId(null);
    }
  };

  const submitSimulation = async () => {
    const payload = {
      kinematicViscosity: fluidProperties.kinematicViscosity,
      density: fluidProperties.density,
      inlets: inlets,
      stl_base64: stlBase64
    };

    setLogs([]);
    setSliceData(null);
    setIsSimulating(true);

    try {
      const response = await fetch('http://127.0.0.1:3000/simulate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.body) {
        throw new Error('ReadableStream not supported by the browser.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      let buffer = '';
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          setIsSimulating(false);
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        
        // Parse SSE format (data: ...\n\n)
        let lines = buffer.split('\n\n');
        buffer = lines.pop(); // Keep the last incomplete chunk in the buffer

        for (let line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.replace('data: ', '');
            
            // Check if this is the JSON heatmap slice payload
            if (data.startsWith('[SLICE]')) {
              try {
                const sliceJson = data.replace('[SLICE]', '');
                const slice = JSON.parse(sliceJson);
                setSliceData(slice);
              } catch (e) {
                console.error("Failed to parse slice data", e);
              }
            } else {
              // It's just a text log
              setLogs(prev => [...prev, data]);
              
              // Auto-scroll to bottom of log view
              if (logsEndRef.current) {
                logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
              }
            }
          }
        }
      }
    } catch (error) {
      setLogs(prev => [...prev, "Error: Make sure the Rust server is running on port 3000!"]);
      setIsSimulating(false);
      console.error(error);
    }
  };

  // Helper to calculate maximum magnitude in the slice to normalize colors
  const maxMag = sliceData ? Math.max(...sliceData.map(c => c.mag)) : 1;

  return (
    <div className="app-container">
      {/* SIDEBAR CONTROL PANEL */}
      <aside className="controls-sidebar">
        <div className="sidebar-header">
          <h1>LiqVid</h1>
          <p>Vol. 1 — CFD Simulation Engine</p>
        </div>

        <div className="form-section">
          <h2 className="section-title">I. Fluid Properties</h2>
          
          <div className="form-group">
            <label>Kinematic Viscosity (ν)</label>
            <input 
              type="number" 
              step="0.00001"
              value={fluidProperties.kinematicViscosity}
              onChange={(e) => setFluidProperties({...fluidProperties, kinematicViscosity: parseFloat(e.target.value)})}
            />
          </div>

          <div className="form-group">
            <label>Density (ρ)</label>
            <input 
              type="number" 
              value={fluidProperties.density}
              onChange={(e) => setFluidProperties({...fluidProperties, density: parseFloat(e.target.value)})}
            />
          </div>
        </div>

        <div className="form-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', marginBottom: '8px' }}>
            <h2 className="section-title" style={{ border: 'none', margin: 0, padding: 0 }}>II. Fluid Inlets</h2>
            <button 
              onClick={addInlet} 
              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: 'bold' }}
            >
              <Plus size={14} /> ADD
            </button>
          </div>
          
          <p style={{fontSize: '10px', color: '#666', marginBottom: '12px'}}>
            * <b>Pro Tip:</b> Double-click anywhere on the 3D model to instantly place a new inlet!
          </p>

          {inlets.map(inlet => {
            const isPlacing = placingInletId === inlet.id;
            return (
              <div 
                key={inlet.id} 
                style={{ 
                  border: isPlacing ? '2px solid #00ffcc' : '1px solid var(--border-color)', 
                  padding: '12px', 
                  marginBottom: '12px',
                  background: isPlacing ? 'rgba(0, 255, 204, 0.1)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', alignItems: 'center' }}>
                  <strong style={{ fontSize: '14px' }}>Inlet #{inlet.id} {isPlacing && "(Click model to place)"}</strong>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {!isPlacing && (
                      <button 
                        onClick={() => setPlacingInletId(inlet.id)}
                        style={{ background: 'var(--text-color)', color: 'var(--bg-color)', border: 'none', padding: '4px 8px', fontSize: '10px', cursor: 'pointer', fontWeight: 'bold' }}
                      >
                        REPOSITION
                      </button>
                    )}
                    <button 
                      onClick={() => removeInlet(inlet.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e53e3e', display: 'flex', alignItems: 'center' }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="form-group" style={{marginTop: '8px'}}>
                  <label>Position (x, y, z)</label>
                  <div className="vector-inputs">
                    <input type="number" step="0.1" value={inlet.position.x} onChange={(e) => updateInletVector(inlet.id, 'position', 'x', e.target.value)} disabled={isPlacing} />
                    <input type="number" step="0.1" value={inlet.position.y} onChange={(e) => updateInletVector(inlet.id, 'position', 'y', e.target.value)} disabled={isPlacing} />
                    <input type="number" step="0.1" value={inlet.position.z} onChange={(e) => updateInletVector(inlet.id, 'position', 'z', e.target.value)} disabled={isPlacing} />
                  </div>
                </div>

                <div className="form-group" style={{marginTop: '8px'}}>
                  <label>Velocity (x, y, z)</label>
                  <div className="vector-inputs">
                    <input type="number" step="0.1" value={inlet.velocity.x} onChange={(e) => updateInletVector(inlet.id, 'velocity', 'x', e.target.value)} />
                    <input type="number" step="0.1" value={inlet.velocity.y} onChange={(e) => updateInletVector(inlet.id, 'velocity', 'y', e.target.value)} />
                    <input type="number" step="0.1" value={inlet.velocity.z} onChange={(e) => updateInletVector(inlet.id, 'velocity', 'z', e.target.value)} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <input 
          type="file" 
          accept=".stl" 
          ref={fileInputRef} 
          style={{ display: 'none' }} 
          onChange={handleFileUpload} 
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: 'auto' }}>
          <button className="upload-btn" onClick={() => fileInputRef.current.click()} style={{ flex: 1 }}>
            <Upload size={18} />
            STL
          </button>
          
          <button 
            className="upload-btn" 
            onClick={submitSimulation} 
            disabled={isSimulating}
            style={{ 
              flex: 2, 
              background: isSimulating ? '#ccc' : 'var(--text-color)', 
              color: isSimulating ? '#666' : 'var(--bg-color)',
              cursor: isSimulating ? 'not-allowed' : 'pointer'
            }}
          >
            {isSimulating ? 'SIMULATING...' : 'RUN SIMULATION'}
          </button>
        </div>
      </aside>

      {/* 3D VIEWER AREA */}
      <main className="viewer-container" style={{ position: 'relative' }}>
        
        {/* VELOCITY PROMPT OVERLAY */}
        {velocityPrompt && (
          <div style={{ 
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', 
            background: 'var(--bg-color)', border: '2px solid var(--border-color)', padding: '24px', 
            zIndex: 100, display: 'flex', flexDirection: 'column', gap: '16px', 
            boxShadow: '8px 8px 0px var(--border-color)' 
          }}>
            <h3 style={{fontFamily: 'Playfair Display', fontSize: '20px', margin: 0, borderBottom: '2px solid #111', paddingBottom: '8px'}}>
              Set Initial Velocity
            </h3>
            <p style={{fontSize: '12px', color: '#666'}}>Enter the velocity vector (x, y, z) for this inlet.</p>
            <div className="vector-inputs">
              <input type="number" step="0.1" value={velocityPrompt.vx} onChange={e => setVelocityPrompt({...velocityPrompt, vx: parseFloat(e.target.value)||0})} />
              <input type="number" step="0.1" value={velocityPrompt.vy} onChange={e => setVelocityPrompt({...velocityPrompt, vy: parseFloat(e.target.value)||0})} />
              <input type="number" step="0.1" value={velocityPrompt.vz} onChange={e => setVelocityPrompt({...velocityPrompt, vz: parseFloat(e.target.value)||0})} />
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <button 
                className="upload-btn" 
                onClick={() => setVelocityPrompt(null)} 
                style={{padding: '10px', flex: 1, background: '#eee', color: '#333', border: '1px solid #ccc'}}
              >
                CANCEL
              </button>
              <button 
                className="upload-btn" 
                onClick={submitVelocityPrompt} 
                style={{padding: '10px', flex: 2}}
              >
                CONFIRM & PLACE
              </button>
            </div>
          </div>
        )}

        {/* LIVE SIMULATION LOG TERMINAL */}
        {(logs.length > 0 || isSimulating) && (
          <div style={{
            position: 'absolute',
            bottom: '24px',
            right: '24px',
            width: '400px',
            height: '250px',
            background: 'rgba(17, 17, 17, 0.95)',
            color: '#00ffcc',
            fontFamily: 'monospace',
            fontSize: '12px',
            padding: '16px',
            borderRadius: '8px',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px', marginBottom: '8px', color: '#fff' }}>
              <Terminal size={14} />
              <strong style={{ letterSpacing: '1px' }}>RUST SOLVER OUTPUT</strong>
              {isSimulating && <span style={{ marginLeft: 'auto', color: '#00ffcc', animation: 'pulse 1.5s infinite' }}>● LIVE</span>}
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {logs.map((log, index) => (
                <div key={index}>{`> ${log}`}</div>
              ))}
              <div ref={logsEndRef} />
            </div>
          </div>
        )}

        {!stlFileUrl ? (
          <div className="empty-state">
            <Box />
            <p>Awaiting Geometry Import...</p>
          </div>
        ) : (
          <Canvas camera={{ position: [0, 0, 100], fov: 50 }}>
            <ambientLight intensity={1.5} />
            <directionalLight position={[10, 10, 10]} intensity={2} />
            <Environment preset="city" />
            
            <axesHelper args={[50]} />
            
            <Center>
              <StlModel fileUrl={stlFileUrl} onPointSelect={handlePointSelect} onDoubleClick={handleDoubleClick} />
            </Center>
            
            {/* Render a bright neon sphere for the currently active velocity prompt */}
            {velocityPrompt && (
              <mesh position={[velocityPrompt.point.x, velocityPrompt.point.y, velocityPrompt.point.z]}>
                <sphereGeometry args={[2.5, 32, 32]} />
                <meshStandardMaterial color="#00ffcc" emissive="#00ffcc" emissiveIntensity={0.5} />
              </mesh>
            )}

            {/* Render a sphere for each placed inlet */}
            {inlets.map(inlet => (
              <mesh key={inlet.id} position={[inlet.position.x, inlet.position.y, inlet.position.z]}>
                <sphereGeometry args={[2, 16, 16]} />
                <meshStandardMaterial 
                  color={placingInletId === inlet.id ? "#00ffcc" : "#e53e3e"} 
                  emissive={placingInletId === inlet.id ? "#00ffcc" : "#000000"} 
                  emissiveIntensity={placingInletId === inlet.id ? 0.5 : 0}
                />
              </mesh>
            ))}

            {/* CFD HEATMAP RENDERER (Slice at Z = 10 in mesh) */}
            {sliceData && sliceData.map((cell, index) => {
              // Normalize magnitude from 0.0 (blue) to 1.0 (red)
              const normalized = maxMag > 0 ? cell.mag / maxMag : 0;
              // Hue: 240 is blue, 0 is red
              const hue = (1 - normalized) * 240;
              const color = `hsl(${hue}, 100%, 50%)`;
              
              // Scale opacity based on velocity. Slow fluid = invisible, Fast fluid = opaque.
              const opacity = Math.min(0.8, normalized * 1.5);
              
              // Hide cells with virtually no velocity to keep the view clean
              if (opacity < 0.05) return null;

              return (
                // Shift forward to Z=2 so it hovers slightly above the STL and stops glitching (Z-fighting)
                <mesh key={`cell-${index}`} position={[cell.x, cell.y, 2]}>
                  <planeGeometry args={[4.8, 4.8]} />
                  <meshBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
                </mesh>
              );
            })}

            <OrbitControls makeDefault />
          </Canvas>
        )}
      </main>
    </div>
  );
}

export default App;
