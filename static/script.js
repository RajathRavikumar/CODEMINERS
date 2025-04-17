class HealthChain {
  constructor() {
    console.log("Loading HealthChain...");
    this.logs = [];
    this.meds = [];
    this.loadDataFromDB();
    if (typeof Blockchain === "undefined") {
      console.error("Blockchain class not defined. Ensure blocks/blockchain.js is loaded.");
      this.blockchain = null;
      document.getElementById("chain-status").textContent = "Unavailable";
      document.getElementById("blockchain-view").innerHTML = "<p>Blockchain functionality unavailable. Other features are still operational.</p>";
    } else {
      this.blockchain = new Blockchain();
      console.log("Blockchain initialized successfully.");
    }
    this.initForms();
    this.initCharts();
    this.updateViews();
    this.setupWearableSync();
    this.checkSession();
    console.log("HealthChain initialized.");
  }

  async fetchWithRetry(url, options, retries = 1, delay = 1000) {
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetch(url, options);
        if (response.status === 500) {
          throw new Error(`Server error: ${response.status}`);
        }
        return response;
      } catch (error) {
        if (i < retries) {
          console.warn(`Fetch failed for ${url}, retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  updateViews() {
    this.updateLogHistory();
    this.updateMedList();
    this.updateBlockchainView();
  }

  async checkSession() {
    try {
      const response = await this.fetchWithRetry("/api/reports", { credentials: "include" });
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

  async loadDataFromDB() {
    try {
      const logsResponse = await this.fetchWithRetry("/api/logs", { credentials: "include" });
      if (logsResponse.status === 401 || logsResponse.status === 302) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!logsResponse.ok) {
        throw new Error(`HTTP error ${logsResponse.status}`);
      }
      this.logs = await logsResponse.json();

      const medsResponse = await this.fetchWithRetry("/api/meds", { credentials: "include" });
      if (medsResponse.status === 401 || medsResponse.status === 302) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!medsResponse.ok) {
        throw new Error(`HTTP error ${medsResponse.status}`);
      }
      this.meds = await medsResponse.json();

      const blockchainResponse = await this.fetchWithRetry("/api/blockchain/status", { credentials: "include" });
      if (blockchainResponse.status === 401 || blockchainResponse.status === 302) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!blockchainResponse.ok) {
        throw new Error(`HTTP error ${blockchainResponse.status}`);
      }
      const chainData = await blockchainResponse.json();
      if (this.blockchain && chainData.status === "active") {
        // Adjust based on actual blockchain API response structure
      }
      this.updateViews();
    } catch (error) {
      console.error("Failed to load data from DB:", error);
    }
  }

  async verifyMedicine(name) {
    console.log(`Verifying medicine: ${name}`);
    try {
      const response = await this.fetchWithRetry('/api/verify-medicine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medicine_name: name }),
        credentials: 'include'
      });
      if (response.status === 401 || response.status === 302) {
        window.location.href = '/static/login.html';
        return { is_valid: false, reason: 'Session expired' };
      }
      if (!response.ok) throw new Error('Failed to verify medicine');
      const data = await response.json();
      console.log(`Verification response:`, data);
      if (typeof data.is_valid !== 'boolean') {
        throw new Error('Invalid response structure from server');
      }
      return data;
    } catch (error) {
      console.error('Verification error:', error);
      return { is_valid: false, reason: `Verification failed: ${error.message}` };
    }
  }

  async saveLog(log) {
    try {
      const response = await this.fetchWithRetry("/api/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(log),
        credentials: "include",
      });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      this.logs.push(log);
      this.addBlock("health_log", log);
      this.updateLogHistory();
      this.updateCharts();
    } catch (error) {
      console.error("Failed to save log:", error);
    }
  }

  async saveMed(med) {
    const verification = await this.verifyMedicine(med.name);
    if (!verification.is_valid) {
      alert(`Invalid medicine name: ${med.name}. ${verification.reason || 'Please enter a valid medicine.'}`);
      return;
    }
    try {
      const response = await this.fetchWithRetry("/api/meds", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `name=${encodeURIComponent(med.name)}&time=${encodeURIComponent(med.time)}&dosage=${encodeURIComponent(med.dosage || '')}`,
        credentials: "include",
      });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      this.meds.push(med);
      this.scheduleReminder(med);
      this.addBlock("medication", med);
      this.updateMedList();
    } catch (error) {
      console.error("Failed to save med:", error);
    }
  }

  initForms() {
    document.getElementById("health-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const log = {
        mood: document.getElementById("mood").value,
        sleep: parseFloat(document.getElementById("sleep").value),
        water: parseFloat(document.getElementById("water").value),
        exercise: parseFloat(document.getElementById("exercise").value) || 0,
        note: document.getElementById("note").value,
        timestamp: new Date().toISOString(),
      };
      await this.saveLog(log);
      e.target.reset();
    });

    document.getElementById("med-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const med = {
        name: document.getElementById("med-name").value,
        time: document.getElementById("med-time").value,
        dosage: document.getElementById("med-dosage").value,
        timestamp: new Date().toISOString(),
      };
      await this.saveMed(med);
      e.target.reset();
    });

    document.getElementById("med-reminder").addEventListener("click", async () => {
      const fullName = document.getElementById("med-name").value.trim();
      if (!fullName) {
        document.getElementById("error-message").textContent = "Please enter a medicine name.";
        document.getElementById("error-popup").style.display = "block";
        return;
      }
      const time = document.getElementById("med-time").value;
      if (!time) {
        document.getElementById("error-message").textContent = "Please select a reminder time.";
        document.getElementById("error-popup").style.display = "block";
        return;
      }

      const verification = await this.verifyMedicine(fullName);
      if (!verification.is_valid) {
        document.getElementById("error-message").textContent = `Invalid medicine name: ${fullName}. ${verification.reason || 'Please enter a valid medicine.'}`;
        document.getElementById("error-popup").style.display = "block";
        return;
      }

      const reminderTime = new Date();
      const [hours, minutes] = time.split(":");
      reminderTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      if (reminderTime <= new Date()) {
        reminderTime.setDate(reminderTime.getDate() + 1); // Set for next day if past current time
      }
      const unixTime = reminderTime.getTime();

      try {
        const response = await this.fetchWithRetry("/api/send-email-reminder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: fullName, time: unixTime }),
          credentials: "include",
        });
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const data = await response.json();
        alert(`Reminder successfully set for ${fullName} at ${reminderTime.toLocaleTimeString()}`);
      } catch (error) {
        console.error("Failed to set reminder:", error);
        document.getElementById("error-message").textContent = `Failed to set reminder: ${error.message}`;
        document.getElementById("error-popup").style.display = "block";
      }
    });

    document.getElementById("symptom-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const symptoms = document.getElementById("symptoms-input").value.toLowerCase().split(",").map(s => s.trim()).filter(s => s);
      const age = parseInt(document.getElementById("age-input").value);
      const gender = document.getElementById("gender-input").value;
      if (!symptoms.length || !age || !gender) {
        alert("Please fill all required fields.");
        return;
      }
      await this.checkSymptoms(symptoms, age, gender);
    });

    document.getElementById("voice-input-btn").addEventListener("click", () => {
      const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
      recognition.lang = "en-US";
      recognition.start();
      recognition.onresult = async (event) => {
        const spokenSymptoms = event.results[0][0].transcript;
        document.getElementById("symptoms-input").value = spokenSymptoms;
        const symptoms = spokenSymptoms.split(",").map(s => s.trim()).filter(s => s);
        const age = parseInt(document.getElementById("age-input").value);
        const gender = document.getElementById("gender-input").value;
        if (!symptoms.length || !age || !gender) {
          alert("Please fill all required fields.");
          return;
        }
        await this.checkSymptoms(symptoms, age, gender);
      };
      recognition.onerror = () => alert("Voice input failed. Please try again.");
    });

    document.getElementById("logout-btn").addEventListener("click", async () => {
      try {
        await fetch("/api/logout", { credentials: "include" });
        window.location.href = "/static/login.html";
      } catch (error) {
        console.error("Logout failed:", error);
      }
    });
  }

  async checkSymptoms(symptoms, age, gender) {
    const resultDiv = document.getElementById("ai-result");
    const medDiv = document.getElementById("medicine-suggestions");
    resultDiv.textContent = "Checking symptoms...";
    medDiv.textContent = "";
    try {
      const response = await this.fetchWithRetry("/api/symptoms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symptoms, age, gender }),
        credentials: "include",
      });
      if (response.status === 401 || response.status === 302) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      const data = await response.json();
      this.displayDiagnosis(data);
      this.addBlock("symptom_check", { symptoms, diagnoses: data.diagnoses });
      this.provideMentalHealthTips(symptoms);
      this.displayMedicineSuggestions(data.medicine_suggestions);
    } catch (error) {
      console.error("Symptom check error:", error);
      resultDiv.textContent = `❌ Error checking symptoms: ${error.message}`;
    }
  }

  displayDiagnosis(data) {
    const resultDiv = document.getElementById("ai-result");
    resultDiv.innerHTML = data.diagnoses.length
      ? `<strong>🧠 Possible conditions:</strong><br>` + data.diagnoses.map(d => `${d.condition}: ${d.confidence}%`).join("<br>")
      : "❌ No matching conditions found.";
  }

  displayMedicineSuggestions(suggestions) {
    const medDiv = document.getElementById("medicine-suggestions");
    medDiv.innerHTML = suggestions.length
      ? `<strong>💊 Suggested Medicines:</strong><br>` + suggestions.map(s => `${s.medicine} (${s.dosage})`).join("<br>")
      : "No medicine suggestions available.";
  }

  provideMentalHealthTips(symptoms) {
    const tipsDiv = document.getElementById("mental-health-tips");
    const mentalKeywords = ["stress", "anxiety", "depression", "sadness"];
    if (symptoms.some(s => mentalKeywords.includes(s.toLowerCase()))) {
      tipsDiv.innerHTML = `
        <h3>🧘 Mental Wellness Tips</h3>
        <ul>
          <li>Try 5 minutes of deep breathing exercises.</li>
          <li>Connect with a friend or family member.</li>
          <li>Consider journaling your thoughts daily.</li>
        </ul>
      `;
    } else {
      tipsDiv.innerHTML = "";
    }
  }

  async scheduleReminder(med) {
    const [hours, minutes] = med.time.split(":");
    const now = new Date();
    let reminderTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(hours), parseInt(minutes), 0, 0);
    if (reminderTime <= now) reminderTime.setDate(reminderTime.getDate() + 1);
    const reminderTimestamp = reminderTime.getTime();

    if (reminderTimestamp > Date.now()) {
      const delay = reminderTimestamp - Date.now();
      console.log(`Scheduling email reminder for ${med.name} at ${reminderTime}`);
      setTimeout(async () => {
        try {
          const response = await this.fetchWithRetry("/api/send-email-reminder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: med.name, time: reminderTimestamp }),
            credentials: "include",
          });
          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
          }
          console.log(`Email reminder sent for ${med.name}`);
        } catch (error) {
          console.error("Failed to schedule email reminder:", error);
        }
      }, delay);
    } else {
      console.log(`Reminder time for ${med.name} has passed, skipping email.`);
    }
  }

  initCharts() {
    this.moodChart = new Chart(document.getElementById("moodChart").getContext("2d"), {
      type: "line",
      data: { labels: [], datasets: [{ label: "Mood Score", data: [], borderColor: "#0077ff", fill: false }] },
      options: { scales: { y: { beginAtZero: true, max: 10 } } },
    });
    this.sleepChart = new Chart(document.getElementById("sleepChart").getContext("2d"), {
      type: "bar",
      data: { labels: [], datasets: [{ label: "Sleep Hours", data: [], backgroundColor: "#4CAF50" }] },
      options: { scales: { y: { beginAtZero: true } } },
    });
  }

  updateCharts() {
    const recentLogs = this.logs.slice(-7);
    this.moodChart.data.labels = recentLogs.map(l => new Date(l.timestamp).toLocaleDateString());
    this.moodChart.data.datasets[0].data = recentLogs.map(l => {
      const mood = l.mood.toLowerCase();
      return mood.includes("good") ? 8 : mood.includes("bad") ? 2 : 5;
    });
    this.sleepChart.data.labels = recentLogs.map(l => new Date(l.timestamp).toLocaleDateString());
    this.sleepChart.data.datasets[0].data = recentLogs.map(l => l.sleep);
    this.moodChart.update();
    this.sleepChart.update();
  }

  setupWearableSync() {
    setInterval(() => {
      const mockData = { heartRate: Math.floor(Math.random() * (100 - 60) + 60), steps: Math.floor(Math.random() * 1000) };
      document.getElementById("wearable-data").innerHTML = `Wearable Data: Heart Rate ${mockData.heartRate} bpm, Steps ${mockData.steps}`;
      this.addBlock("wearable", mockData);
    }, 60000);
  }

  addBlock(type, data) {
    if (!this.blockchain) {
      console.warn("Blockchain unavailable, skipping block addition.");
      return;
    }
    const newBlock = new Block(
      this.blockchain.chain.length,
      new Date().toISOString(),
      { type, data, timestamp: new Date().toISOString() },
      this.blockchain.getLatestBlock().hash
    );
    this.blockchain.addBlock(newBlock);
    this.saveBlockchain();
    this.updateBlockchainView();
  }

  async saveBlockchain() {
    try {
      const chainData = this.blockchain.chain.map(block => ({
        index: block.index,
        timestamp: block.timestamp,
        data: block.data,
        previousHash: block.previousHash,
        hash: block.hash
      }));
      const response = await this.fetchWithRetry("/api/blockchain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chainData),
        credentials: "include",
      });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
    } catch (error) {
      console.error("Failed to save blockchain:", error);
    }
  }

  updateLogHistory() {
    document.getElementById("log-history").innerHTML = this.logs.map(log => `
      <div class="block">
        <strong>${new Date(log.timestamp).toLocaleString()}</strong><br>
        Mood: ${log.mood}<br>
        Sleep: ${log.sleep} hrs<br>
        Water: ${log.water} L<br>
        Exercise: ${log.exercise} min<br>
        Note: ${log.note || "None"}
      </div>
    `).join("");
  }

  updateMedList() {
    document.getElementById("med-list").innerHTML = this.meds.map(med => `
      <li>${med.name} at ${med.time}${med.dosage ? ` (${med.dosage})` : ""}</li>
    `).join("");
  }

  updateBlockchainView() {
    if (!this.blockchain) {
      document.getElementById("blockchain-view").innerHTML = "<p>Blockchain functionality unavailable. Other features are still operational.</p>";
      document.getElementById("chain-status").textContent = "Unavailable";
      return;
    }
    document.getElementById("blockchain-view").innerHTML = this.blockchain.chain.map(block => `
      <div class="block">
        <strong>Block #${block.index}</strong><br>
        Timestamp: ${block.timestamp}<br>
        Type: ${block.data.type}<br>
        Data: ${JSON.stringify(block.data.data)}<br>
        Hash: ${block.hash}
      </div>
    `).join("");
    document.getElementById("chain-status").textContent = this.blockchain.isChainValid() ? "Valid" : "Invalid";
  }
}

new HealthChain();