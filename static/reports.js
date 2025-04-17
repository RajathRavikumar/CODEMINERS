class HealthReports {
  constructor() {
    this.initAuth();
    this.initButtons();
    this.video = null; // For camera stream
    this.stream = null; // For managing camera stream
  }

  initAuth() {
    document.getElementById("login-btn").addEventListener("click", () => {
      window.location.href = "/static/login.html";
    });
    document.getElementById("register-btn").addEventListener("click", () => {
      window.location.href = "/static/register.html";
    });
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await fetch("/api/logout", { credentials: "include" });
      window.location.href = "/static/login.html";
    });

    this.checkSession();
  }

  async checkSession() {
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
      alert("Session check failed. Please log in again.");
      window.location.href = "/static/login.html";
    }
  }

  initButtons() {
    const loading = document.getElementById("loading");
    const reportPreview = document.getElementById("report-preview");

    document.getElementById("generate-report").addEventListener("click", async () => {
      loading.classList.add("active");
      try {
        // Fetch all logs for the logged-in user
        const logsResponse = await fetch("/api/logs", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        if (logsResponse.status === 302 || logsResponse.status === 401) {
          window.location.href = "/static/login.html";
          return;
        }
        if (!logsResponse.ok) throw new Error(`HTTP error! status: ${logsResponse.status}`);
        const logs = await logsResponse.json();

        // Prepare form data with logs, username, and image (if any)
        const username = document.getElementById("user-status").textContent;
        const fileInput = document.getElementById("report-file");
        const cameraInput = document.getElementById("camera-input");
        const file = fileInput.files[0] || cameraInput.files[0]; // Use uploaded or captured image

        const formData = new FormData();
        formData.append("username", username);
        formData.append("logs", JSON.stringify(logs));
        if (file) {
          formData.append("image", file);
        }

        // Generate report
        const response = await fetch("/api/reports", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        loading.classList.remove("active");
        if (response.status === 302) {
          window.location.href = "/static/login.html";
          return;
        }
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        const reportId = data.report_id;
        this.updatePreview({ _id: { "$oid": reportId }, summary: data.summary, timestamp: data.timestamp });
        if (data.download_url) {
          this.handleDownload(data.download_url, reportId);
        }
      } catch (error) {
        loading.classList.remove("active");
        console.error("Report generation failed:", error);
        alert(`Failed to generate report: ${error.message}`);
      }
    });

    document.getElementById("take-photo-btn").addEventListener("click", async () => {
      try {
        const cameras = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = cameras.filter(device => device.kind === "videoinput");
        if (videoDevices.length === 0) {
          alert("No camera detected on this device.");
          return;
        }

        const cameraSelect = document.getElementById("camera-select");
        cameraSelect.style.display = videoDevices.length > 1 ? "inline" : "none";
        if (videoDevices.length > 1) {
          cameraSelect.innerHTML = "";
          videoDevices.forEach(device => {
            const option = document.createElement("option");
            option.value = device.deviceId;
            option.text = device.label || (device.deviceId === videoDevices[0].deviceId ? "Rear Camera" : "Front Camera");
            cameraSelect.appendChild(option);
          });
        }

        const constraints = {
          video: {
            deviceId: videoDevices.length > 1 ? { exact: cameraSelect.value } : undefined,
            facingMode: videoDevices.length === 1 ? "environment" : undefined
          }
        };

        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.video = document.createElement("video");
        this.video.style.display = "none";
        document.body.appendChild(this.video);
        this.video.srcObject = this.stream;
        await this.video.play();

        const canvas = document.createElement("canvas");
        canvas.width = this.video.videoWidth;
        canvas.height = this.video.videoHeight;
        const context = canvas.getContext("2d");
        context.drawImage(this.video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(blob => {
          const cameraInput = document.getElementById("camera-input");
          cameraInput.files = new DataTransfer().files; // Clear previous files
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(new File([blob], "captured-photo.jpg", { type: "image/jpeg" }));
          cameraInput.files = dataTransfer.files;
          this.stopCamera();
          // Trigger report generation after capturing photo
          document.getElementById("generate-report").click();
        }, "image/jpeg");
      } catch (error) {
        console.error("Camera access failed:", error);
        alert("Failed to access camera: " + error.message);
        this.stopCamera();
      }
    });

    document.getElementById("upload-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      loading.classList.add("active");
      const fileInput = document.getElementById("report-file");
      const cameraInput = document.getElementById("camera-input");
      const file = fileInput.files[0] || cameraInput.files[0]; // Use file input or camera input
      if (!file) {
        loading.classList.remove("active");
        document.getElementById("analysis-result").innerHTML = `<p>Error: No file or photo selected</p>`;
        return;
      }
      const formData = new FormData();
      formData.append("file", file);
      try {
        const analyzeResponse = await fetch("/api/analyze-report", {
          method: "POST",
          body: formData,
          credentials: "include",
        });
        if (!analyzeResponse.ok) {
          const errorText = await analyzeResponse.text();
          throw new Error(`HTTP error! status: ${analyzeResponse.status}, details: ${errorText}`);
        }
        const data = await analyzeResponse.json();
        document.getElementById("analysis-result").innerHTML = `
          <h3>AI Analysis</h3>
          <p>${data.analysis.ai_analysis || 'No analysis available'}</p>
          <details>
            <summary>Extracted Text</summary>
            <pre>${data.analysis.extracted_text || 'No text extracted'}</pre>
          </details>
        `;
      } catch (error) {
        console.error("Analysis failed:", error);
        document.getElementById("analysis-result").innerHTML = `<p>Error: ${error.message}</p>`;
      }
      loading.classList.remove("active");
    });
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      document.body.removeChild(this.video);
      this.video = null;
    }
    document.getElementById("camera-select").style.display = "none";
  }

  updatePreview(report) {
    const reportPreview = document.getElementById("report-preview");
    if (report && report._id && report._id["$oid"]) {
      reportPreview.style.display = "none";
      reportPreview.textContent = `Summary: ${report.summary} (Generated: ${report.timestamp})`;
    } else {
      reportPreview.style.display = "block";
      console.warn("Report not found, retrying...");
    }
  }

  handleDownload(downloadUrl, reportId) {
    const downloadLink = document.getElementById("download-link");
    downloadLink.href = downloadUrl;
    downloadLink.download = `report_${reportId}.pdf`;
    downloadLink.style.display = "block";
    downloadLink.textContent = "Download Report";
  }
}

new HealthReports();