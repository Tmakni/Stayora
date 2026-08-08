// Utilitaires globaux pour le frontend

// XSS protection — escape HTML entities before inserting user content into DOM
function escapeHtml(str) {
  if (typeof str !== 'string') return str || '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  return str.replace(/[&<>"']/g, c => map[c]);
}

// API Request helper
async function apiRequest(url, options = {}) {
  const token = localStorage.getItem('token');
  
  const config = {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    }
  };
  
  if (options.body) {
    config.body = JSON.stringify(options.body);
  }
  
  try {
    let response = await fetch(url, config);
    
    // If token expired, try to refresh it once
    if (response.status === 401 && token && !options._retried) {
      const refreshed = await tryRefreshToken(token);
      if (refreshed) {
        config.headers['Authorization'] = `Bearer ${localStorage.getItem('token')}`;
        options._retried = true;
        response = await fetch(url, config);
      } else {
        logout();
        throw new Error('Session expirée. Veuillez vous reconnecter.');
      }
    }
    
    const data = await response.json();
    
    if (!response.ok) {
      const err = new Error(data.error || data.message || 'Request failed');
      err.status = response.status;
      err.data = data;
      throw err;
    }
    
    if (Array.isArray(data)) {
      return data;
    }
    
    if (data.conversations) {
      return data.conversations;
    }
    
    return data;
  } catch (error) {
    console.error('API error:', error.message);
    throw error;
  }
}

// Try to refresh an expired JWT token
async function tryRefreshToken(expiredToken) {
  try {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiredToken })
    });
    
    if (!response.ok) return false;
    
    const data = await response.json();
    if (data.token) {
      localStorage.setItem('token', data.token);
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

// Check auth
function checkAuth() {
  const token = localStorage.getItem('token');
  
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  
  return true;
}

// Logout — also stops any active polling/SSE
function logout() {
  // Stop background timers
  if (typeof dashPollTimer !== 'undefined' && dashPollTimer) { clearInterval(dashPollTimer); dashPollTimer = null; }
  if (typeof _evtSource !== 'undefined' && _evtSource) { _evtSource.close(); _evtSource = null; }
  localStorage.removeItem('token');
  localStorage.removeItem('user_email');
  window.location.href = '/login.html';
}

// Show error
function showError(message) {
  const errorDiv = document.getElementById('error-message');
  
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    
    setTimeout(() => {
      errorDiv.classList.add('hidden');
    }, 5000);
  } else {
    alert('Error: ' + message);
  }
}

// Show success
function showSuccess(message) {
  // Créer un élément de message de succès temporaire
  const successDiv = document.createElement('div');
  successDiv.className = 'alert alert-success';
  successDiv.textContent = message;
  successDiv.style.position = 'fixed';
  successDiv.style.top = '20px';
  successDiv.style.right = '20px';
  successDiv.style.zIndex = '9999';
  successDiv.style.minWidth = '300px';
  successDiv.style.animation = 'slideIn 0.3s ease';
  
  document.body.appendChild(successDiv);
  
  setTimeout(() => {
    successDiv.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      document.body.removeChild(successDiv);
    }, 300);
  }, 3000);
}

// Format date
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diff = now - date;
  
  // Si moins de 24h, afficher "il y a X heures"
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    if (hours === 0) {
      const minutes = Math.floor(diff / (60 * 1000));
      return minutes <= 1 ? 'À l\'instant' : `Il y a ${minutes} min`;
    }
    return hours === 1 ? 'Il y a 1 heure' : `Il y a ${hours} heures`;
  }
  
  // Sinon format date
  const options = { 
    day: '2-digit', 
    month: 'short', 
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit'
  };
  
  return date.toLocaleDateString('fr-FR', options);
}

