// medical-services.js
document.addEventListener('DOMContentLoaded', () => {
  const map = L.map('medical-services-map').setView([51.505, -0.09], 13); // Default to London
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const findClinicsBtn = document.getElementById('find-clinics-btn');
  const serviceTypeSelect = document.getElementById('service-type');
  const searchRadiusInput = document.getElementById('search-radius');
  const loadingIndicator = document.createElement('div');
  loadingIndicator.textContent = 'Loading medical services...';
  loadingIndicator.style.cssText = 'position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #0077ff;';

  // Session check and username display
  async function checkSession() {
    try {
      const response = await fetch("/api/reports", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const reports = await response.json();
      const username = reports.length > 0 ? reports[0].username || "User" : "User";
      document.getElementById("login-btn").style.display = "none";
      document.getElementById("register-btn").style.display = "none";
      document.getElementById("logout-btn").style.display = "inline";
      document.getElementById("user-status").textContent = username;
    } catch (error) {
      console.error("Session check failed:", error);
      window.location.href = "/static/login.html";
    }
  }
  checkSession();

  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await fetch("/api/logout", { credentials: "include" });
      window.location.href = "/static/login.html";
    } catch (error) {
      console.error("Logout failed:", error);
    }
  });

  if (findClinicsBtn) {
    findClinicsBtn.addEventListener('click', () => {
      if (navigator.geolocation) {
        map.getContainer().appendChild(loadingIndicator);
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const userLat = position.coords.latitude;
            const userLng = position.coords.longitude;
            map.setView([userLat, userLng], 13);
            fetchMedicalServices(userLat, userLng, map);
            loadingIndicator.remove();
          },
          (error) => {
            loadingIndicator.remove();
            alert(`Geolocation error: ${error.message}. Using fallback location (London).`);
            fetchMedicalServices(51.505, -0.09, map);
          },
          { timeout: 10000, maximumAge: 0 } // Timeout after 10s
        );
      } else {
        loadingIndicator.remove();
        alert('Geolocation is not supported by this browser. Using fallback location (London).');
        fetchMedicalServices(51.505, -0.09, map);
      }
    });
  }

  function fetchMedicalServices(lat, lng, map) {
    const radius = parseInt(searchRadiusInput.value) || 5000;
    let query = `[out:json];(node["amenity"~"hospital|clinic|pharmacy"](around:${radius},${lat},${lng}););out body;`;
    const selectedType = serviceTypeSelect.value;
    if (selectedType !== 'all') {
      query = `[out:json];(node["amenity"="${selectedType}"](around:${radius},${lat},${lng}););out body;`;
    }
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    map.getContainer().appendChild(loadingIndicator);
    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        return response.json();
      })
      .then(data => {
        map.eachLayer(layer => {
          if (layer instanceof L.Marker) map.removeLayer(layer);
        });
        data.elements.forEach(service => {
          const { lat, lon, tags } = service;
          const marker = L.marker([lat, lon]).addTo(map);
          marker.bindPopup(`
            <b>${tags.name || 'Unnamed'}</b><br>
            Type: ${tags.amenity}<br>
            ${tags.phone ? `Phone: ${tags.phone}<br>` : ''}
            ${tags.website ? `<a href="${tags.website}" target="_blank">Website</a><br>` : ''}
            <button class="save-favorite-btn" data-lat="${lat}" data-lon="${lon}" data-name="${tags.name || 'Unnamed'}" data-type="${tags.amenity}">Save as Favorite</button>
          `);
        });
        loadingIndicator.remove();
      })
      .catch(error => {
        loadingIndicator.remove();
        alert(`Error fetching medical services: ${error.message}. Please try again or check your internet connection.`);
      });
  }

  // Handle saving favorites to blockchain
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('save-favorite-btn')) {
      const lat = e.target.dataset.lat;
      const lon = e.target.dataset.lon;
      const name = e.target.dataset.name;
      const type = e.target.dataset.type;
      const favoriteData = {
        type: 'favorite_clinic',
        data: { name, type, lat, lon, timestamp: new Date().toISOString() }
      };
      fetch('/api/blockchain/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Ensure session is included
        body: JSON.stringify(favoriteData)
      })
      .then(response => response.json())
      .then(data => {
        if (data.status === 'success') {
          alert(`${name} saved as a favorite!`);
        } else {
          alert(`Failed to save favorite: ${data.detail || 'Unknown error'}`);
        }
      })
      .catch(error => alert(`Error saving favorite: ${error.message}`));
    }
  });
});