class NutritionTracker {
  constructor() {
    this.nutrition = [];
    this.loadNutrition();
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

  async loadNutrition() {
    try {
      const response = await fetch("/api/nutrition", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const data = await response.json();
      console.log("API Response:", data);
      this.nutrition = Array.isArray(data.entries) ? [...data.entries] : [];
      this.updateSummary(data.today_summary || { calories: 0, protein: 0, fats: 0, carbs: 0, suggestion: "" });
      this.updateHistory();
    } catch (error) {
      console.error("Failed to load nutrition:", error);
      alert("Failed to load nutrition data. Please try again or log in if needed.");
      this.nutrition = [];
      this.updateSummary();
      this.updateHistory();
    }
  }

  initForm() {
    const form = document.getElementById("nutrition-form");
    const loading = document.getElementById("loading");
    const nutrientInputs = document.getElementById("nutrient-inputs");
    const confirmBtn = document.getElementById("confirm-btn");

    if (!form || !loading || !nutrientInputs || !confirmBtn) {
      console.error("One or more DOM elements not found");
      return;
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const foodItem = document.getElementById("food-item");
      if (!foodItem || !foodItem.value || !foodItem.value.trim()) {
        alert("Please enter a valid food item.");
        return;
      }

      loading.style.display = "block";
      try {
        const response = await fetch("/api/nutrition/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ food_item: foodItem.value.trim() }),
          credentials: "include",
        });
        if (response.status === 302 || response.status === 401) {
          window.location.href = "/static/login.html";
          return;
        }
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP error ${response.status}`);
        }
        const data = await response.json();
        if (data.status === "success") {
          document.getElementById("calories").value = data.calories || 0;
          document.getElementById("protein").value = data.protein || 0;
          document.getElementById("fats").value = data.fats || 0;
          document.getElementById("carbs").value = data.carbs || 0;
          nutrientInputs.style.display = "block";
        } else {
          throw new Error(data.detail || "Failed to fetch nutrients");
        }
      } catch (error) {
        console.error("Fetch nutrients error:", error);
        alert(`Failed to fetch nutrients: ${error.message}. Please check your input or try again later.`);
      } finally {
        loading.style.display = "none";
      }
    });

    confirmBtn.addEventListener("click", async () => {
      const foodItem = document.getElementById("food-item").value.trim();
      const calories = parseFloat(document.getElementById("calories").value) || 0;
      const protein = parseFloat(document.getElementById("protein").value) || 0;
      const fats = parseFloat(document.getElementById("fats").value) || 0;
      const carbs = parseFloat(document.getElementById("carbs").value) || 0;

      if (!foodItem) {
        alert("Please enter a food item.");
        return;
      }
      if (calories < 0 || protein < 0 || fats < 0 || carbs < 0) {
        alert("Nutrient values cannot be negative.");
        return;
      }

      const nutrition = {
        food_item: foodItem,
        calories,
        protein,
        fats,
        carbs,
        timestamp: new Date().toISOString()
      };

      loading.style.display = "block";
      try {
        const response = await fetch("/api/nutrition", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nutrition),
          credentials: "include",
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.detail || "Failed to add nutrition");
        }
        alert(data.suggestion || "Nutrition added successfully!");
        await this.loadNutrition(); // Refresh data
        form.reset();
        nutrientInputs.style.display = "none";
      } catch (error) {
        console.error("Add nutrition error:", error);
        alert(`Failed to add nutrition: ${error.message}. Please try again.`);
      } finally {
        loading.style.display = "none";
      }
    });
  }

  updateSummary(summary = { calories: 0, protein: 0, fats: 0, carbs: 0, suggestion: "" }) {
    const totalCalories = document.getElementById("total-calories");
    const totalProtein = document.getElementById("total-protein");
    const totalFats = document.getElementById("total-fats");
    const totalCarbs = document.getElementById("total-carbs");
    const suggestion = document.getElementById("suggestion");

    if (!totalCalories || !totalProtein || !totalFats || !totalCarbs || !suggestion) {
      console.warn("One or more summary elements not found");
      return;
    }

    totalCalories.textContent = summary.calories.toFixed(1);
    totalProtein.textContent = summary.protein.toFixed(1);
    totalFats.textContent = summary.fats.toFixed(1);
    totalCarbs.textContent = summary.carbs.toFixed(1);
    suggestion.textContent = summary.suggestion || "No suggestion available.";
  }

  updateHistory() {
    if (!Array.isArray(this.nutrition)) {
      console.warn("nutrition is not an array:", this.nutrition);
      this.nutrition = [];
    }

    const historyContainer = document.getElementById("nutrition-history");
    if (!historyContainer) {
      console.warn("History container not found");
      return;
    }

    historyContainer.innerHTML = this.nutrition
      .map(n => {
        if (!n.food_item || typeof n.calories !== "number") {
          console.warn("Invalid nutrition entry:", n);
          return "";
        }
        return `
          <div class="block">
            <strong>${new Date(n.timestamp).toLocaleString()}</strong><br>
            Food: ${n.food_item}<br>
            Calories: ${n.calories.toFixed(1)} kcal<br>
            Protein: ${n.protein.toFixed(1)} g<br>
            Fats: ${n.fats.toFixed(1)} g<br>
            Carbs: ${n.carbs.toFixed(1)} g
          </div>
        `;
      })
      .join("");
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

document.getElementById("logout-btn").addEventListener("click", () => new NutritionTracker().logout());

// Instantiate the tracker
new NutritionTracker();