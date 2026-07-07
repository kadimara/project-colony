import { useEffect } from 'react'
import './colony.css'
import { initColonyGame } from './game'

function Colony() {
  useEffect(() => {
    initColonyGame()
  }, [])

  return (
    <div className="stage">
      <div className="canvas-stage">
        <div className="viewport-wrap">
          <canvas id="game" width={272} height={192} style={{ width: '816px', height: '576px' }} />
        </div>

        <div className="statusbar">
          <div className="stat">
            <span className="stat-label">Caste</span>
            <span className="stat-value" id="stat-caste">none</span>
          </div>
          <div className="stat">
            <span className="stat-label">HP</span>
            <span className="stat-value" id="stat-hp">20/20</span>
          </div>
          <div className="stat">
            <span className="stat-label">Carrying</span>
            <span className="stat-value" id="stat-carry">nothing</span>
          </div>
          <div className="stat">
            <span className="stat-label">Trail marks</span>
            <span className="stat-value" id="stat-trail">0</span>
          </div>
          <div className="stat">
            <span className="stat-label">Colony</span>
            <span className="stat-value" id="stat-population">0</span>
          </div>
          <div className="stat">
            <span className="stat-label">Nest level</span>
            <span className="stat-value" id="stat-nest-level">0</span>
          </div>
          <div className="stat seed-control">
            <span className="stat-label">Seed</span>
            <input id="seed-input" className="seed-input" type="text" />
            <button id="seed-load-btn" className="switch-caste-btn">Load</button>
            <button id="seed-random-btn" className="switch-caste-btn">Random</button>
          </div>
          <button id="map-toggle-btn" className="switch-caste-btn">Map <span className="key">M</span></button>
          <button id="switch-caste-btn" className="switch-caste-btn">Switch caste <span className="key">C</span></button>
        </div>

        <div className="zoom-controls">
          <button id="zoom-in-btn" className="zoom-btn">+</button>
          <button id="zoom-out-btn" className="zoom-btn">&minus;</button>
        </div>

        <div className="toast" id="toast" />

        <div className="world-map-overlay" id="world-map-overlay">
          <div className="world-map-panel">
            <div className="world-map-title">World map <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>— drag or scroll to pan</span></div>
            <div className="worldmap-scroll" id="worldmap-scroll">
              <canvas id="worldmap-canvas" />
            </div>
            <button className="switch-caste-btn" id="world-map-close">Close</button>
          </div>
        </div>

        <div className="caste-overlay" id="caste-overlay">
          <div className="caste-heading" id="caste-heading">choose your caste</div>
          <div className="caste-row" id="caste-row" />
          <div className="caste-cancel" id="caste-cancel" style={{ display: 'none' }}>keep current caste</div>
        </div>

        <div className="caste-overlay" id="nest-overlay" style={{ display: 'none' }}>
          <div className="caste-heading">the nest</div>
          <div className="caste-stats" id="nest-status" style={{ maxWidth: '280px', textAlign: 'center', lineHeight: 1.6 }} />
          <div className="caste-row" id="nest-row" />
          <div className="caste-cancel" id="nest-cancel">close</div>
        </div>
      </div>

      <div className="legend">
        <span className="legend-item"><span className="swatch" style={{ background: '#d99a3f' }} />worker</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#b23a3a' }} />soldier</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#3fae9e' }} />scout</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#8a8478' }} />obstacle</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#e8c44f' }} />food</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#9be89b' }} />scent trail</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#8b3fae' }} />enemy</span>
        <span className="legend-item"><span className="swatch" style={{ background: '#f2efe6' }} />nest</span>
      </div>

      <p className="hint">
        <span className="key">click / tap</span> to move &nbsp;·&nbsp;
        <span className="key">WASD</span> / arrows also work &nbsp;·&nbsp;
        <b>Worker</b>: click an obstacle or food to pick it up, click open ground to set it back down &nbsp;·&nbsp;
        <b>Scout</b>: walk to food and it lays a scent trail along the path it took to get there, and can tunnel through walls (slower) to reach sealed-off pockets &nbsp;·&nbsp;
        <b>Soldier</b>: bigger — click a nearby enemy to attack it &nbsp;·&nbsp;
        <span className="key">C</span> or the button switches your caste anytime, keeping your position &nbsp;·&nbsp;
        scroll or <span className="key">+</span> <span className="key">&minus;</span> to zoom, <span className="key">M</span> for the world map &nbsp;·&nbsp;
        <b>Nest</b>: click it to choose what to spawn — stand inside its food circle with enough food nearby, which gets consumed &nbsp;·&nbsp;
        everything that dies — player, colonist, or enemy — drops a food item behind &nbsp;·&nbsp;
        the world is generated from the seed shown top-right — share it to explore the same cave
      </p>
    </div>
  )
}

export default Colony
