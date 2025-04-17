class Forum {
  constructor() {
    this.posts = [];
    this.checkSession();
    this.loadPosts();
    this.initForm();
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

  async loadPosts() {
    try {
      const response = await this.fetchWithRetry("http://localhost:8000/api/forum", { credentials: "include" });
      if (response.status === 302 || response.status === 401) {
        window.location.href = "/static/login.html";
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      this.posts = await response.json();
      this.updateView();
    } catch (error) {
      console.error("Failed to load posts:", error);
    }
  }

  initForm() {
    document.getElementById("post-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const post = {
        title: document.getElementById("post-title").value,
        content: document.getElementById("post-content").value,
        timestamp: new Date().toISOString(),
        user_id: "anonymous",
      };
      try {
        const response = await this.fetchWithRetry("http://localhost:8000/api/forum", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(post),
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
          this.posts.push(post);
          this.updateView();
          document.getElementById("post-form").reset();
        } else {
          alert(`Post rejected: ${data.detail || data.reason}`);
        }
      } catch (error) {
        console.error("Failed to post:", error);
        alert(`Post failed: ${error.message}`);
      }
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

  updateView() {
    document.getElementById("forum-posts").innerHTML = this.posts.map(p => `
      <div class="block">
        <h3>${p.title}</h3>
        <p>${p.content}</p>
        <small>${new Date(p.timestamp).toLocaleString()} by ${p.user_id}</small>
      </div>
    `).join("");
  }
}

new Forum();