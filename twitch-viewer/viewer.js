const PARENT = "alnico-dig.github.io";

let liveChannels = []; 
// [{ login:"aaa", title:"xxx" }]

let players = [];
let playerSlots = [];
let infoBars = [];
let cellWrappers = [];

let readyCount = 0;
let allReady = false;

let displayStartIndex = 0;
let activeSlotCount = 0;

let groupCountdown = GROUP_ROTATE_INTERVAL;
let volumeCountdown = VOLUME_ROTATE_INTERVAL;

let currentVolumeIndex = 0;

let noLiveMessage;

/* =========================
   Live一括取得（ローテ同期型）
========================= */

async function updateLives() {

  if (!allReady) return;

  if (channels.length === 0) {
    liveChannels = [];
    updateDisplayedChannels();
    return;
  }

  try {

    const params = channels
      .map(ch => `user_login=${encodeURIComponent(ch)}`)
      .join("&");

    const res = await fetch(
      `https://api.twitch.tv/helix/streams?${params}`,
      {
        headers: {
          "Client-ID": CLIENT_ID,
          "Authorization": `Bearer ${APP_TOKEN}`
        }
      }
    );

    const data = await res.json();

    const liveMap = new Map();

    (data.data || []).forEach(stream => {
      liveMap.set(stream.user_login.toLowerCase(), {
        login: stream.user_login,
        title: stream.title || ""
      });
    });

    liveChannels = channels
      .filter(ch => liveMap.has(ch.toLowerCase()))
      .map(ch => liveMap.get(ch.toLowerCase()));

    if (displayStartIndex >= liveChannels.length) {
      displayStartIndex = 0;
    }

    updateDisplayedChannels();

  } catch (e) {
    console.error("Helix fetch error:", e);
  }
}

/* =========================
   初期生成
========================= */

function initializePlayers() {

  const grid = document.getElementById("grid");

  for (let i = 0; i < 4; i++) {

    const wrapper = document.createElement("div");
    wrapper.className = "cell";

    const playerArea = document.createElement("div");
    playerArea.className = "player-area";

    const playerDiv = document.createElement("div");
    playerArea.appendChild(playerDiv);

    const infoBar = document.createElement("div");
    infoBar.className = "info-bar";

    wrapper.appendChild(playerArea);
    wrapper.appendChild(infoBar);
    grid.appendChild(wrapper);

    cellWrappers.push(wrapper);
    playerSlots.push(playerDiv);
    infoBars.push(infoBar);
  }

  noLiveMessage = document.createElement("div");
  noLiveMessage.className = "no-live-message";
  noLiveMessage.innerText = "現在ライブなし";
  grid.appendChild(noLiveMessage);

  requestAnimationFrame(() => {

    for (let i = 0; i < 4; i++) {

      const initialChannel =
        channels[i % channels.length];

      const player = new Twitch.Player(playerSlots[i], {
        channel: initialChannel,
        parent: [PARENT],
        muted: true,
        autoplay: true,
        width: "100%",
        height: "100%",
        quality: QUALITY
      });

      player.addEventListener(Twitch.Player.READY, () => {

        player.play();

        readyCount++;

        if (readyCount === 4) {
          allReady = true;
          updateLives(); // 初回取得
        }
      });

      players.push({
        player,
        channel: initialChannel
      });
    }
  });
}

/* =========================
   表示更新
========================= */

function updateDisplayedChannels() {

  const source = liveChannels;
  activeSlotCount = Math.min(4, source.length);

  const grid = document.getElementById("grid");
  grid.classList.remove(
    "layout-1","layout-2","layout-3","layout-4"
  );

  if (activeSlotCount === 0) {
    grid.classList.add("layout-1");
    noLiveMessage.style.visibility = "visible";
  } else {
    grid.classList.add("layout-" + activeSlotCount);
    noLiveMessage.style.visibility = "hidden";
  }

  for (let i = 0; i < 4; i++) {

    if (i < activeSlotCount) {

      const index =
        (displayStartIndex + i) % source.length;

      const data = source[index];
      const newChannel = data.login;
      const newTitle = data.title;

      cellWrappers[i].style.visibility = "visible";

      if (players[i].channel !== newChannel) {
        players[i].player.setChannel(newChannel);
        players[i].channel = newChannel;
      }

      infoBars[i].dataset.title = newTitle;

    } else {

      players[i].player.setMuted(true);
      cellWrappers[i].style.visibility = "hidden";
      infoBars[i].innerHTML = "";
      infoBars[i].classList.remove("active");
      cellWrappers[i].classList.remove("active-cell");
    }
  }

  if (currentVolumeIndex >= activeSlotCount) {
    currentVolumeIndex = 0;
  }

  updateVolumes();
  updateInfoBars();
}

/* =========================
   音量制御
========================= */

function updateVolumes() {

  for (let i = 0; i < 4; i++) {

    if (i === currentVolumeIndex && i < activeSlotCount) {

      players[i].player.setMuted(false);
      players[i].player.setVolume(0.8);

      infoBars[i].classList.add("active");
      cellWrappers[i].classList.add("active-cell");

    } else {

      players[i].player.setMuted(true);

      infoBars[i].classList.remove("active");
      cellWrappers[i].classList.remove("active-cell");
    }
  }
}

/* =========================
   情報バー更新（タイトル対応）
========================= */

function updateInfoBars() {

  for (let i = 0; i < 4; i++) {

    if (i < activeSlotCount) {

      const channel = players[i].channel;
      const title = infoBars[i].dataset.title || "";

      infoBars[i].innerHTML = `
        <span class="left">${channel}</span>
        <span class="center">${title}</span>
        <span class="right">G:${groupCountdown}s V:${volumeCountdown}s</span>
      `;
    }
  }
}

/* =========================
   タイマー
========================= */

function tick() {

  if (!allReady) return;

  /* 音量ローテ */

  if (activeSlotCount > 0) {
    volumeCountdown--;
  } else {
    volumeCountdown = VOLUME_ROTATE_INTERVAL;
  }

  if (volumeCountdown <= 0 && activeSlotCount > 0) {

    currentVolumeIndex =
      (currentVolumeIndex + 1) % activeSlotCount;

    volumeCountdown = VOLUME_ROTATE_INTERVAL;
    updateVolumes();
  }

  /* 表示ローテ（Live取得同期） */

  if (liveChannels.length > 4) {

    groupCountdown--;

    if (groupCountdown <= 0) {

      updateLives(); // ★ ローテ直前に取得

      displayStartIndex =
        (displayStartIndex + 4) % liveChannels.length;

      groupCountdown = GROUP_ROTATE_INTERVAL;

      currentVolumeIndex = 0;
      volumeCountdown = VOLUME_ROTATE_INTERVAL;
    }

  } else {

    groupCountdown = GROUP_ROTATE_INTERVAL;
  }

  updateInfoBars();
}

/* =========================
   起動
========================= */

document.addEventListener("DOMContentLoaded", initializePlayers);
setInterval(tick, 1000);