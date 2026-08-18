// Stack-chan Config Editor — Frontend Logic

const statusDiv = document.getElementById('status');
const errorDiv = document.getElementById('error');
const robotIpInput = document.getElementById('robotIp');
const backendSelect = document.getElementById('backend');
const openclawSection = document.getElementById('openclawSection');
const hermesSection = document.getElementById('hermesSection');

// Restore robot IP from localStorage
const savedIp = localStorage.getItem('stackchan.robotIp');
if (savedIp) robotIpInput.value = savedIp;

function showStatus(msg) {
  statusDiv.textContent = msg;
  errorDiv.textContent = '';
}
function showError(msg) {
  errorDiv.textContent = msg;
  statusDiv.textContent = '';
}

function getRobotIp() {
  const ip = robotIpInput.value.trim();
  if (ip) localStorage.setItem('stackchan.robotIp', ip);
  return ip;
}

// Toggle sections based on backend
function updateBackendVisibility() {
  const backend = backendSelect.value;
  if (backend === '1') {
    openclawSection.classList.add('dim');
    hermesSection.classList.remove('dim');
  } else {
    openclawSection.classList.remove('dim');
    hermesSection.classList.add('dim');
  }
}
backendSelect.addEventListener('change', updateBackendVisibility);
updateBackendVisibility();

// Collect all form fields into a config object
function collectConfig() {
  const config = {
    backend: parseInt(backendSelect.value),
    openclaw: {
      host: val('oc_host'),
      port: parseInt(val('oc_port')) || 18789,
      model: val('oc_model'),
      agent_id: val('oc_agent_id'),
      bot_token: val('oc_bot_token'),
      default_model: val('oc_default_model'),
    },
    hermes: {
      host: val('hm_host'),
      port: parseInt(val('hm_port')) || 0,
      model: val('hm_model'),
      agent_id: val('hm_agent_id'),
      bot_token: val('hm_bot_token'),
      default_model: val('hm_default_model'),
    },
    llm: {
      type: parseInt(val('llm_type')),
      model: val('llm_model'),
      enableMemory: val('llm_enableMemory') === 'true',
    },
    tts: {
      type: parseInt(val('tts_type')),
      model: val('tts_model'),
      voice: val('tts_voice'),
    },
    stt: {
      type: parseInt(val('stt_type')),
      model: val('stt_model'),
    },
    wakeword: {
      type: parseInt(val('ww_type')),
      keyword: val('ww_keyword'),
    },
    moduleLLM: {
      rxPin: parseInt(val('mod_rxPin')) || 13,
      txPin: parseInt(val('mod_txPin')) || 14,
    },
  };
  return config;
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el && value !== undefined && value !== null) {
    el.value = typeof value === 'number' ? String(value) : value;
  }
}

// Populate form from config object
function populateConfig(config) {
  if (!config) return;
  
  setVal('backend', config.backend || 0);
  backendSelect.value = String(config.backend || 0);
  
  if (config.openclaw) {
    setVal('oc_host', config.openclaw.host);
    setVal('oc_port', config.openclaw.port);
    setVal('oc_model', config.openclaw.model);
    setVal('oc_agent_id', config.openclaw.agent_id);
    setVal('oc_bot_token', config.openclaw.bot_token);
    setVal('oc_default_model', config.openclaw.default_model);
  }
  
  if (config.hermes) {
    setVal('hm_host', config.hermes.host);
    setVal('hm_port', config.hermes.port);
    setVal('hm_model', config.hermes.model);
    setVal('hm_agent_id', config.hermes.agent_id);
    setVal('hm_bot_token', config.hermes.bot_token);
    setVal('hm_default_model', config.hermes.default_model);
  }
  
  if (config.llm) {
    setVal('llm_type', config.llm.type);
    setVal('llm_model', config.llm.model);
    setVal('llm_enableMemory', String(config.llm.enableMemory));
  }
  
  if (config.tts) {
    setVal('tts_type', config.tts.type);
    setVal('tts_model', config.tts.model);
    setVal('tts_voice', config.tts.voice);
  }
  
  if (config.stt) {
    setVal('stt_type', config.stt.type);
    setVal('stt_model', config.stt.model);
  }
  
  if (config.wakeword) {
    setVal('ww_type', config.wakeword.type);
    setVal('ww_keyword', config.wakeword.keyword);
  }
  
  if (config.moduleLLM) {
    setVal('mod_rxPin', config.moduleLLM.rxPin);
    setVal('mod_txPin', config.moduleLLM.txPin);
  }
  
  updateBackendVisibility();
}

// Load from robot
async function loadFromRobot() {
  const ip = getRobotIp();
  if (!ip) {
    showError('Enter the robot IP address first');
    return;
  }
  
  showStatus('Loading from robot...');
  try {
    const res = await fetch(`/api/config?robotIp=${encodeURIComponent(ip)}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const config = await res.json();
    populateConfig(config);
    showStatus('Config loaded from robot ✓');
  } catch (e) {
    showError('Load failed: ' + e.message);
  }
}

// Save & push to robot
async function saveAndPush() {
  const ip = getRobotIp();
  if (!ip) {
    showError('Enter the robot IP address first');
    return;
  }
  
  const config = collectConfig();
  showStatus('Pushing to robot...');
  
  try {
    const res = await fetch('/api/config_set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ robotIp: ip, config }),
    });
    
    const result = await res.json();
    
    if (!res.ok) {
      if (result.localSaved) {
        showStatus('Saved locally (robot unreachable). Will sync next time.');
      } else {
        throw new Error(result.error || `HTTP ${res.status}`);
      }
    } else {
      showStatus('Config pushed to robot ✓ & saved locally ✓');
    }
  } catch (e) {
    showError('Push failed: ' + e.message);
  }
}

// Save local only
async function saveLocal() {
  const config = collectConfig();
  
  try {
    const res = await fetch('/api/config_local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    
    if (!res.ok) throw new Error('Save failed');
    showStatus('Saved locally ✓');
  } catch (e) {
    showError('Local save failed: ' + e.message);
  }
}

// Wire up buttons
document.getElementById('loadBtn').addEventListener('click', loadFromRobot);
document.getElementById('pushBtn').addEventListener('click', saveAndPush);
document.getElementById('localBtn').addEventListener('click', saveLocal);
document.getElementById('loadBtn2').addEventListener('click', loadFromRobot);
document.getElementById('pushBtn2').addEventListener('click', saveAndPush);

// Try loading local config on startup
fetch('/api/config_local')
  .then(res => res.json())
  .then(data => {
    if (data.yaml) {
      showStatus('Loaded saved config from disk. Click "Load from Robot" to sync.');
    }
  })
  .catch(() => {});