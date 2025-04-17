function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
  }
  
  async function checkSession() {
    try {
      const sessionId = getCookie("session_id");
      console.log("Session ID:", sessionId);
      const response = await fetch("/api/session", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (response.status === 401 || response.status === 302) {
        console.warn("Session invalid, redirecting to login");
        window.location.href = "/static/login.html";
        return false;
      }
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const user = await response.json();
      const username = user.username || "User";
      document.getElementById("user-status").textContent = username;
      document.getElementById("login-btn").style.display = "none";
      document.getElementById("register-btn").style.display = "none";
      document.getElementById("logout-btn").style.display = "inline";
      return true;
    } catch (error) {
      console.error("Session check failed:", error);
      document.getElementById("user-status").textContent = "Guest";
      document.getElementById("login-btn").style.display = "inline";
      document.getElementById("register-btn").style.display = "inline";
      document.getElementById("logout-btn").style.display = "none";
      window.location.href = "/static/login.html";
      return false;
    }
  }
  
  function setupNavigation() {
    document.getElementById("login-btn").addEventListener("click", () => {
      window.location.href = "/static/login.html";
    });
  
    document.getElementById("register-btn").addEventListener("click", () => {
      window.location.href = "/static/register.html";
    });
  
    document.getElementById("logout-btn").addEventListener("click", async () => {
      try {
        const response = await fetch("/api/logout", {
          method: "POST",
          credentials: "include"
        });
        if (response.ok) {
          window.location.href = "/static/login.html";
        } else {
          throw new Error("Logout failed");
        }
      } catch (error) {
        console.error("Logout failed:", error);
        alert("Logout failed. Please try again.");
      }
    });
  }
  
  async function loadDoctors() {
    try {
      const sessionId = getCookie("session_id");
      console.log("Fetching doctors with session_id:", sessionId);
      const response = await fetch("/api/doctors", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (response.status === 401 || response.status === 302) {
        console.warn("Unauthorized, redirecting to login");
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Response is not JSON");
      }
      const doctors = await response.json();
      const list = document.getElementById("doctor-list");
      list.innerHTML = doctors.length > 0
        ? doctors.map(doc => `
            <div class="doctor">
              <p>Name: ${doc.name}</p>
              <p>Location: ${doc.location}</p>
              <button onclick="requestAppointment('${doc._id}')">Request Appointment</button>
            </div>
          `).join("")
        : "<p>No doctors available.</p>";
    } catch (error) {
      console.error("Failed to load doctors:", error);
      document.getElementById("doctor-list").innerHTML = "<p>Failed to load doctors. Please try again or log in.</p>";
    }
  }
  
  function filterDoctors() {
    const location = document.getElementById("location-filter").value.toLowerCase();
    const doctors = document.getElementsByClassName("doctor");
    for (let doctor of doctors) {
      const docLocation = doctor.getElementsByTagName("p")[1].textContent.split(": ")[1].toLowerCase();
      doctor.style.display = docLocation.includes(location) ? "block" : "none";
    }
  }
  
  async function requestAppointment(doctorId) {
    const patientEmail = prompt("Enter your email to receive confirmation:");
    if (!patientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail)) {
      document.getElementById("appointment-message").textContent = "Please enter a valid email.";
      return;
    }
  
    try {
      const response = await fetch("/api/appointments/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doctor_id: doctorId, patient_email: patientEmail }),
        credentials: "include",
      });
      const data = await response.json();
      document.getElementById("appointment-message").textContent = response.ok
        ? data.message || "Appointment requested! Check your email."
        : data.detail || "Failed to request appointment.";
    } catch (error) {
      document.getElementById("appointment-message").textContent = "An error occurred. Please try again.";
      console.error("Request appointment error:", error);
    }
  }
  
  // Initialize page
  window.addEventListener("load", async () => {
    setupNavigation();
    const isAuthenticated = await checkSession();
    if (isAuthenticated) {
      setTimeout(loadDoctors, 500); // Delay to ensure session is set
    }
  });