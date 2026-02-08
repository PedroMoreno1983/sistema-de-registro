const currentYear = new Date().getFullYear();
const yearElement = document.getElementById("current-year");

if (yearElement) {
  yearElement.textContent = currentYear;
}

const loginForm = document.getElementById("login-form");
const logoutButton = document.getElementById("logout-button");
const loginStatus = document.getElementById("login-status");

const userForm = document.getElementById("user-form");
const shiftForm = document.getElementById("shift-form");
const listingForm = document.getElementById("listing-form");
const listingSearch = document.getElementById("listing-search");

const userStatus = document.getElementById("user-status");
const shiftStatus = document.getElementById("shift-status");
const listingStatus = document.getElementById("listing-status");

const usersList = document.getElementById("users-list");
const shiftsList = document.getElementById("shifts-list");
const listingsList = document.getElementById("listings-list");
const ordersList = document.getElementById("orders-list");
const cartList = document.getElementById("cart-list");
const checkoutButton = document.getElementById("checkout-button");
const checkoutStatus = document.getElementById("checkout-status");
const alertsList = document.getElementById("alerts-list");
const shiftReport = document.getElementById("shift-report");

const shiftGuardSelect = document.getElementById("shift-guard");
const listingOwnerSelect = document.getElementById("listing-owner");

const roleLabels = {
  administrador: "Administrador",
  arrendatario: "Arrendatario",
  dueno_residente: "Dueño residente",
  dueno_no_residente: "Dueño no residente",
  conserje: "Conserje",
};

const typeLabels = {
  venta: "Venta",
  servicio: "Servicio",
  trueque: "Trueque",
  dropshipping: "Dropshipping",
};

let currentUser = null;

function validatePassword(password) {
  const minLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);
  return minLength && hasUpper && hasLower && hasNumber;
}

function getToken() {
  return localStorage.getItem("sessionToken");
}

function setToken(token) {
  if (token) {
    localStorage.setItem("sessionToken", token);
  } else {
    localStorage.removeItem("sessionToken");
  }
}

async function fetchJson(url, options = {}) {
  const headers = options.headers || {};
  const token = getToken();
  if (token) {
    headers["x-session-token"] = token;
  }
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Error inesperado" }));
    throw new Error(error.error || "Error inesperado");
  }
  return response.json();
}

function setStatus(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.style.color = isError ? "#b91c1c" : "#15803d";
}

function renderList(container, items, emptyMessage) {
  if (!container) return;
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = `<div class="list-item">${emptyMessage}</div>`;
    return;
  }
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = item;
    container.appendChild(div);
  });
}

async function loadUsers() {
  const users = await fetchJson("/api/users");
  renderList(
    usersList,
    users.map((user) => {
      const role = roleLabels[user.role] || user.role;
      return `
        <strong>${user.name}</strong><br/>
        <span class="badge success">${role}</span>
        ${user.unit ? `<span class="badge warning">${user.unit}</span>` : ""}
        <div>${user.contact || "Sin contacto"}</div>
      `;
    }),
    "No hay perfiles registrados aún."
  );

  const guardOptions = users.filter((user) => user.role === "conserje");
  const ownerOptions = users.filter((user) => user.role !== "conserje");

  shiftGuardSelect.innerHTML = guardOptions.length
    ? guardOptions
        .map((user) => `<option value="${user.id}">${user.name}</option>`)
        .join("")
    : "<option value=\"\">No hay conserjes aún</option>";

  listingOwnerSelect.innerHTML = ownerOptions.length
    ? ownerOptions
        .map((user) => `<option value="${user.id}">${user.name}</option>`)
        .join("")
    : "<option value=\"\">Registra un perfil primero</option>";
}

async function loadShifts() {
  const shifts = await fetchJson("/api/shifts");
  const canCheck = currentUser?.role === "administrador" || currentUser?.role === "conserje";
  renderList(
    shiftsList,
    shifts.map((shift) => `
      <strong>${shift.guard || "Conserje"}</strong><br/>
      <span class="badge success">${shift.date}</span>
      <span class="badge warning">${shift.start} - ${shift.end}</span>
      <span class="badge success">${shift.status || "programado"}</span>
      <div>${shift.notes || "Sin notas"}</div>
      ${shift.check_in ? `<div>Ingreso: ${new Date(shift.check_in).toLocaleString()}</div>` : ""}
      ${shift.check_out ? `<div>Salida: ${new Date(shift.check_out).toLocaleString()}</div>` : ""}
      ${canCheck && shift.status !== "en_progreso" && shift.status !== "finalizado" ? `<button class="button primary" data-checkin="${shift.id}">Check-in</button>` : ""}
      ${canCheck && shift.status === "en_progreso" ? `<button class="button secondary" data-checkout="${shift.id}">Check-out</button>` : ""}
    `),
    "No hay turnos programados."
  );

  shiftsList.querySelectorAll("button[data-checkin]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/shifts/${button.dataset.checkin}/check-in`, {
          method: "POST",
        });
        await loadShifts();
      } catch (error) {
        setStatus(shiftStatus, error.message, true);
      }
    });
  });

  shiftsList.querySelectorAll("button[data-checkout]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/shifts/${button.dataset.checkout}/check-out`, {
          method: "POST",
        });
        await loadShifts();
      } catch (error) {
        setStatus(shiftStatus, error.message, true);
      }
    });
  });
}

async function loadAlerts() {
  if (currentUser?.role !== "administrador") {
    renderList(alertsList, [], "Solo administrador.");
    return;
  }
  const alerts = await fetchJson("/api/alerts");
  renderList(
    alertsList,
    alerts.map((alert) => `
      <strong>${alert.type}</strong><br/>
      <div>${alert.message}</div>
      <div>${new Date(alert.created_at).toLocaleString()}</div>
    `),
    "No hay alertas."
  );
}

async function loadShiftReport() {
  if (currentUser?.role !== "administrador") {
    renderList(shiftReport, [], "Solo administrador.");
    return;
  }
  const report = await fetchJson("/api/reports/shifts");
  renderList(
    shiftReport,
    report.totals.map((row) => `
      <strong>${row.status}</strong>: ${row.total}
    `),
    "Sin datos."
  );
}

async function loadListings() {
  const listings = await fetchJson("/api/listings");
  const isAdmin = currentUser?.role === "administrador";
  const searchValue = listingSearch?.value?.toLowerCase() || "";
  const filtered = listings.filter((listing) => {
    if (!searchValue) return true;
    const title = listing.title?.toLowerCase() || "";
    const category = listing.category?.toLowerCase() || "";
    return title.includes(searchValue) || category.includes(searchValue);
  });
  renderList(
    listingsList,
    filtered.map((listing) => `
      <strong>${listing.title}</strong><br/>
      <span class="badge success">${typeLabels[listing.type] || listing.type}</span>
      <span class="badge warning">${listing.price || "Sin precio"}</span>
      <span class="badge success">${listing.status || "pending"}</span>
      <span class="badge warning">Stock: ${listing.stock ?? 0}</span>
      ${listing.category ? `<div>Categoría: ${listing.category}</div>` : ""}
      ${listing.image_url ? `<div><a href="${listing.image_url}" target="_blank">Ver imagen</a></div>` : ""}
      <div>Publicado por: ${listing.owner || "N/D"}</div>
      <div>${listing.description || "Sin descripción"}</div>
      <button class="button primary" data-cart="${listing.id}">Agregar al carrito</button>
      <button class="button secondary" data-report="${listing.id}">Reportar</button>
      <button class="button secondary" data-review="${listing.id}">Reseñar</button>
      ${isAdmin && listing.status !== "approved" ? `<button class="button secondary" data-approve="${listing.id}">Aprobar</button>` : ""}
      ${isAdmin || currentUser?.id === listing.owner_id ? `<button class="button secondary" data-edit="${listing.id}">Editar</button>` : ""}
      ${isAdmin || currentUser?.id === listing.owner_id ? `<button class="button secondary" data-delete="${listing.id}">Eliminar</button>` : ""}
    `),
    "No hay publicaciones aún."
  );

  listingsList.querySelectorAll("button[data-cart]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson("/api/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ listingId: button.dataset.cart }),
        });
        await loadCart();
        setStatus(listingStatus, "Producto agregado al carrito.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });

  listingsList.querySelectorAll("button[data-approve]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/listings/${button.dataset.approve}/approve`, {
          method: "POST",
        });
        await loadListings();
        setStatus(listingStatus, "Publicación aprobada.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });

  listingsList.querySelectorAll("button[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/listings/${button.dataset.delete}`, {
          method: "DELETE",
        });
        await loadListings();
        setStatus(listingStatus, "Publicación eliminada.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });

  listingsList.querySelectorAll("button[data-edit]").forEach((button) => {
    button.addEventListener("click", async () => {
      const title = prompt("Nuevo título");
      if (!title) return;
      const price = prompt("Nuevo precio");
      const type = prompt("Tipo (venta/servicio/trueque/dropshipping)");
      const category = prompt("Categoría");
      const stock = prompt("Stock disponible");
      const imageUrl = prompt("URL de imagen");
      const description = prompt("Descripción");
      try {
        await fetchJson(`/api/listings/${button.dataset.edit}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, price, type, description, category, stock, imageUrl }),
        });
        await loadListings();
        setStatus(listingStatus, "Publicación actualizada.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });

  listingsList.querySelectorAll("button[data-report]").forEach((button) => {
    button.addEventListener("click", async () => {
      const reason = prompt("Motivo del reporte");
      try {
        await fetchJson(`/api/listings/${button.dataset.report}/report`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        setStatus(listingStatus, "Reporte enviado.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });

  listingsList.querySelectorAll("button[data-review]").forEach((button) => {
    button.addEventListener("click", async () => {
      const rating = prompt("Rating (1-5)");
      const comment = prompt("Comentario");
      try {
        await fetchJson(`/api/listings/${button.dataset.review}/reviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rating: Number(rating), comment }),
        });
        setStatus(listingStatus, "Reseña enviada.");
      } catch (error) {
        setStatus(listingStatus, error.message, true);
      }
    });
  });
}

async function loadOrders() {
  const orders = await fetchJson("/api/orders");
  const isAdmin = currentUser?.role === "administrador";
  renderList(
    ordersList,
    orders.map((order) => `
      <strong>${order.listing_title}</strong><br/>
      <span class="badge success">${order.status}</span>
      <span class="badge warning">Comprador: ${order.buyer}</span>
      ${order.paid_at ? `<div>Pago: ${new Date(order.paid_at).toLocaleString()}</div>` : ""}
      ${order.delivered_at ? `<div>Entrega: ${new Date(order.delivered_at).toLocaleString()}</div>` : ""}
      ${order.cancelled_at ? `<div>Cancelado: ${new Date(order.cancelled_at).toLocaleString()}</div>` : ""}
      ${order.refund_at ? `<div>Reembolso: ${new Date(order.refund_at).toLocaleString()}</div>` : ""}
      <div><a href="${order.payment_link}" target="_blank">Abrir link de pago</a></div>
      ${isAdmin ? `
        <button class="button secondary" data-paid="${order.id}">Confirmar pago</button>
        <button class="button secondary" data-delivered="${order.id}">Confirmar entrega</button>
        <button class="button secondary" data-cancel="${order.id}">Cancelar</button>
        <button class="button secondary" data-reject="${order.id}">Rechazar</button>
        <button class="button secondary" data-refund="${order.id}">Reembolsar</button>
      ` : ""}
    `),
    "No hay órdenes registradas."
  );

  if (isAdmin) {
    ordersList.querySelectorAll("button[data-paid]").forEach((button) => {
      button.addEventListener("click", async () => {
        await fetchJson(`/api/orders/${button.dataset.paid}/confirm-payment`, {
          method: "POST",
        });
        await loadOrders();
      });
    });
    ordersList.querySelectorAll("button[data-delivered]").forEach((button) => {
      button.addEventListener("click", async () => {
        await fetchJson(`/api/orders/${button.dataset.delivered}/confirm-delivery`, {
          method: "POST",
        });
        await loadOrders();
      });
    });
    ordersList.querySelectorAll("button[data-cancel]").forEach((button) => {
      button.addEventListener("click", async () => {
        await fetchJson(`/api/orders/${button.dataset.cancel}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelado" }),
        });
        await loadOrders();
      });
    });
    ordersList.querySelectorAll("button[data-reject]").forEach((button) => {
      button.addEventListener("click", async () => {
        await fetchJson(`/api/orders/${button.dataset.reject}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "rechazado" }),
        });
        await loadOrders();
      });
    });
    ordersList.querySelectorAll("button[data-refund]").forEach((button) => {
      button.addEventListener("click", async () => {
        await fetchJson(`/api/orders/${button.dataset.refund}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "reembolsado" }),
        });
        await loadOrders();
      });
    });
  }
}

async function loadCart() {
  const cart = await fetchJson("/api/cart");
  renderList(
    cartList,
    cart.map((item) => `
      <strong>${item.title}</strong><br/>
      <span class="badge success">${typeLabels[item.type] || item.type}</span>
      <span class="badge warning">${item.price || "Sin precio"}</span>
      <button class="button secondary" data-remove="${item.id}">Quitar</button>
    `),
    "Carrito vacío."
  );

  cartList.querySelectorAll("button[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await fetchJson(`/api/cart/${button.dataset.remove}`, { method: "DELETE" });
        await loadCart();
        setStatus(checkoutStatus, "Producto eliminado del carrito.");
      } catch (error) {
        setStatus(checkoutStatus, error.message, true);
      }
    });
  });
}

async function refreshAll() {
  await loadUsers();
  await loadShifts();
  await loadAlerts();
  await loadShiftReport();
  await loadListings();
  await loadCart();
  await loadOrders();
}

function showBackendUnavailable() {
  const message = "Backend no disponible. Inicia el servidor para operar.";
  renderList(usersList, [], message);
  renderList(shiftsList, [], message);
  renderList(alertsList, [], message);
  renderList(shiftReport, [], message);
  renderList(listingsList, [], message);
  renderList(cartList, [], message);
  renderList(ordersList, [], message);
  shiftGuardSelect.innerHTML = "<option value=\"\">Sin datos</option>";
  listingOwnerSelect.innerHTML = "<option value=\"\">Sin datos</option>";
}

function showAuthRequired() {
  const message = "Inicia sesión para ver la información.";
  renderList(usersList, [], message);
  renderList(shiftsList, [], message);
  renderList(alertsList, [], message);
  renderList(shiftReport, [], message);
  renderList(listingsList, [], message);
  renderList(cartList, [], message);
  renderList(ordersList, [], message);
  shiftGuardSelect.innerHTML = "<option value=\"\">Sin sesión</option>";
  listingOwnerSelect.innerHTML = "<option value=\"\">Sin sesión</option>";
}

async function loadSession() {
  try {
    const session = await fetchJson("/api/auth/me");
    currentUser = session;
    setStatus(loginStatus, `Sesión activa: ${session.name}`);
  } catch (error) {
    currentUser = null;
    setStatus(loginStatus, "Sin sesión activa", true);
  }
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(loginStatus, "Validando...");
    const formData = new FormData(loginForm);
    try {
      const response = await fetchJson("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          password: formData.get("password"),
        }),
      });
      setToken(response.token);
      currentUser = response.user;
      setStatus(loginStatus, `Sesión iniciada: ${response.user.name}`);
      await refreshAll();
    } catch (error) {
      setStatus(loginStatus, error.message, true);
    }
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.error(error);
    }
    setToken(null);
    currentUser = null;
    setStatus(loginStatus, "Sesión cerrada");
  });
}

if (userForm) {
  userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(userStatus, "Guardando...");
    const formData = new FormData(userForm);
    const password = formData.get("password");
    if (!validatePassword(password)) {
      setStatus(
        userStatus,
        "Contraseña debe tener 8+ caracteres, mayúscula, minúscula y número.",
        true
      );
      return;
    }
    try {
      await fetchJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          role: formData.get("role"),
          unit: formData.get("unit"),
          contact: formData.get("contact"),
          password,
        }),
      });
      userForm.reset();
      await refreshAll();
      setStatus(userStatus, "Perfil creado correctamente.");
    } catch (error) {
      setStatus(userStatus, error.message, true);
    }
  });
}

if (shiftForm) {
  shiftForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(shiftStatus, "Guardando...");
    const formData = new FormData(shiftForm);
    try {
      await fetchJson("/api/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guardId: formData.get("guard"),
          date: formData.get("date"),
          start: formData.get("start"),
          end: formData.get("end"),
          notes: formData.get("notes"),
        }),
      });
      shiftForm.reset();
      await loadShifts();
      setStatus(shiftStatus, "Turno registrado correctamente.");
    } catch (error) {
      setStatus(shiftStatus, error.message, true);
    }
  });
}

if (listingForm) {
  listingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(listingStatus, "Publicando...");
    const formData = new FormData(listingForm);
    try {
      await fetchJson("/api/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId: formData.get("owner"),
          title: formData.get("title"),
          price: formData.get("price"),
          type: formData.get("type"),
          category: formData.get("category"),
          stock: formData.get("stock"),
          imageUrl: formData.get("image"),
          description: formData.get("description"),
        }),
      });
      listingForm.reset();
      await loadListings();
      setStatus(listingStatus, "Publicación creada correctamente.");
    } catch (error) {
      setStatus(listingStatus, error.message, true);
    }
  });
}

if (listingSearch) {
  listingSearch.addEventListener("input", async () => {
    try {
      await loadListings();
    } catch (error) {
      console.error(error);
    }
  });
}

if (checkoutButton) {
  checkoutButton.addEventListener("click", async () => {
    setStatus(checkoutStatus, "Generando pagos...");
    try {
      await fetchJson("/api/checkout", { method: "POST" });
      await loadCart();
      await loadOrders();
      setStatus(checkoutStatus, "Pagos generados. Revisa órdenes.");
    } catch (error) {
      setStatus(checkoutStatus, error.message, true);
    }
  });
}

refreshAll()
  .then(loadSession)
  .catch((error) => {
    console.error(error);
    if (error.message.includes("Inicia sesión") || error.message.includes("Sin permisos")) {
      showAuthRequired();
    } else {
      showBackendUnavailable();
    }
  });
