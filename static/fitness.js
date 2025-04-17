class FitnessPlan {
  constructor() {
    this.fitness = [];
    this.chart = null; // To store the Chart.js instance
    this.canvasPanel = null; // Store canvasPanel as a class property
    this.loadFitness();
    this.initForm();
    this.checkSession(); // Add session check on instantiation
  }

  async checkSession() {
    try {
      const response = await fetch("/api/reports", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const reports = await response.json();
      const username = reports.length > 0 && reports[0].username ? reports[0].username : "User";
      document.getElementById("user-status").textContent = username;
      document.getElementById("login-btn").style.display = "none";
      document.getElementById("register-btn").style.display = "none";
      document.getElementById("logout-btn").style.display = "inline";
    } catch (error) {
      console.error("Session check failed:", error);
      document.getElementById("user-status").textContent = "Guest";
      document.getElementById("login-btn").style.display = "inline";
      document.getElementById("register-btn").style.display = "inline";
      document.getElementById("logout-btn").style.display = "none";
    }
  }

  async loadFitness() {
    try {
      const response = await fetch("/api/fitness", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      this.fitness = await response.json();
      this.updateView();
      this.getFitnessPlan(); // Load plan on initial load
      this.getProgress(); // Load progress on initial load
    } catch (error) {
      console.error("Failed to load fitness:", error);
      alert("Failed to load fitness data. Check the console for details. Using empty data as fallback.");
      this.fitness = [];
      this.updateView();
    }
  }

  initForm() {
    const form = document.getElementById("fitness-form");
    const planBtn = document.getElementById("plan-btn");

    if (!planBtn) {
      console.error("Plan button not found in DOM");
      return;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fitness = {
        exercise_name: document.getElementById("exercise-name").value,
        duration: parseInt(document.getElementById("duration").value),
        intensity: parseInt(document.getElementById("intensity").value),
        weight: parseFloat(document.getElementById("weight").value) || null,
        goal: document.getElementById("goal").value || null,
        fitness_level: document.getElementById("fitness-level").value || null,
        timestamp: new Date().toISOString(),
      };
      console.log("Form data before submission:", fitness); // Debug log
      if (!fitness.exercise_name || fitness.duration <= 0 || fitness.intensity <= 0 || fitness.intensity > 10) {
        alert("Please enter a valid exercise name, duration, and intensity (1-10).");
        return;
      }
      if (!fitness.goal || !fitness.fitness_level) {
        alert("Please select a goal and fitness level.");
        return;
      }

      try {
        const response = await fetch("/api/fitness", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            exercise_name: fitness.exercise_name,
            duration: fitness.duration,
            intensity: fitness.intensity,
            weight: fitness.weight || "",
            goal: fitness.goal || "",
            fitness_level: fitness.fitness_level || ""
          }).toString(),
          credentials: "include",
        });
        if (response.status === 302 || response.status === 401) {
          window.location.href = "/static/login.html";
          return;
        }
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}`);
        }
        const data = await response.json();
        if (data.status === "success") {
          this.fitness.push(fitness);
          this.updateView();
          form.reset();
          alert(`Fitness logged successfully! ID: ${data.fitness_id}`);
          this.getProgress(); // Refresh progress after logging
        } else {
          throw new Error(data.detail || "Failed to add exercise");
        }
      } catch (error) {
        alert(`Failed to log fitness: ${error.message}`);
      }
    });

    planBtn.addEventListener("click", () => {
      console.log("Plan button clicked, calling getFitnessPlan");
      this.getFitnessPlan();
    });
  }

  async getFitnessPlan() {
    console.log("Attempting to fetch fitness plan from /api/fitness/plan");
    try {
      const response = await fetch("/api/fitness/plan", { credentials: "include" });
      console.log("Fetch response status:", response.status);
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();
      console.log("Plan response:", data);
      if (data.status === "success") {
        document.getElementById("fitness-plan-view").innerHTML = `
          <div class="block">
            <h3>Your Personalized Workout Plan</h3>
            <p><strong>Suggestion:</strong> ${data.workout_suggestion}</p>
            <p><strong>Estimated Calories Burned:</strong> ${data.estimated_calories_burned} kcal</p>
            <p><strong>Based on:</strong> Weight: ${data.weight} kg, Goal: ${data.goal}, Level: ${data.fitness_level}</p>
          </div>
        `;
      } else {
        document.getElementById("fitness-plan-view").innerHTML = `<div class="block"><p>${data.message}</p></div>`;
      }
    } catch (error) {
      console.error("Failed to get fitness plan:", error);
      document.getElementById("fitness-plan-view").innerHTML = `<div class="block"><p>Failed to load plan. Check console.</p></div>`;
    }
  }

  async getProgress() {
    try {
      const response = await fetch("/api/fitness/progress", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();
      console.log("Progress data:", data);
      this.displayProgress(data);
    } catch (error) {
      console.error("Failed to get progress:", error);
    }
  }

  displayProgress(data) {
    // Initialize or reuse canvasPanel
    if (!this.canvasPanel) {
      this.canvasPanel = document.getElementById("progress-canvas") || document.createElement("div");
      this.canvasPanel.id = "progress-canvas";
      if (!document.getElementById("progress-canvas")) {
        document.getElementById("fitness-plan-view").appendChild(this.canvasPanel);
      }
    }

    // Ensure canvas container has a fixed height
    this.canvasPanel.style.height = "400px"; // Fixed height to prevent uncontrolled growth
    this.canvasPanel.style.overflowY = "auto"; // Add scroll if content exceeds height

    // Remove existing canvas if it exists
    const existingCanvas = document.getElementById("progressChart");
    if (existingCanvas) existingCanvas.remove();

    const canvas = document.createElement("canvas");
    canvas.id = "progressChart";
    this.canvasPanel.appendChild(canvas);

    // Load Chart.js from CDN
    if (!window.Chart) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/chart.js";
      script.onload = () => this.initializeChart(data);
      document.head.appendChild(script);
    } else {
      this.initializeChart(data);
    }
  }

  initializeChart(data) {
    if (this.chart) {
      this.chart.destroy(); // Destroy previous chart instance
    }

    this.chart = new Chart(this.canvasPanel.querySelector("#progressChart").getContext("2d"), {
      type: "bar",
      data: {
        labels: data.weekly_calories.map(w => w.week).slice(-4), // Limit to last 4 weeks
        datasets: [{
          label: "Calories Burned (kcal)",
          data: data.weekly_calories.map(w => w.calories).slice(-4), // Limit to last 4 weeks
          backgroundColor: "rgba(54, 162, 235, 0.5)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1
        }]
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "Calories (kcal)" }
          },
          x: {
            title: { display: true, text: "Week" }
          }
        },
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 0 // Disable animation to reduce lag
        }
      }
    });

    // Summary
    const durationChange = data.duration_trend.previous_week === 0 ? "N/A" : data.duration_trend.change_percent.toFixed(1);
    const intensityChange = data.intensity_trend.previous_week === 0 ? "N/A" : data.intensity_trend.change_percent.toFixed(1);
    const summary = document.createElement("p");
    summary.innerHTML = `
      <strong>Progress Summary:</strong><br>
      Duration: ${durationChange}% change from last week<br>
      Intensity: ${intensityChange}% change from last week
    `;
    this.canvasPanel.appendChild(summary);
  }

  updateView() {
    document.getElementById("fitness-plan-view").innerHTML = this.fitness.map(f => `
      <div class="block">
        <strong>${new Date(f.timestamp).toLocaleString()}</strong><br>
        Exercise: ${f.exercise_name}<br>
        Duration: ${f.duration} min<br>
        Intensity: ${f.intensity}/10<br>
        Weight: ${f.weight || 'N/A'} kg<br>
        Goal: ${f.goal || 'N/A'}<br>
        Level: ${f.fitness_level || 'N/A'}
      </div>
    `).join("");
  }

  // Logout handler
  async logout() {
    try {
      await fetch("/api/logout", { credentials: "include" });
      window.location.href = "/static/login.html";
    } catch (error) {
      console.error("Logout failed:", error);
      alert("Logout failed. Please try again.");
    }
  }
}

document.getElementById("logout-btn").addEventListener("click", () => new FitnessPlan().logout());

// Instantiate the tracker
new FitnessPlan();