export function meetingInviteUrl(location, meetingId) {
  return `${location.origin}${location.pathname}#/room/${meetingId}`;
}

export function telegramShareUrl(inviteUrl, meetingTitle = 'a VYNQ meeting', botLink = '') {
  const botNote = botLink ? ` Or open VYNQ in Telegram: ${botLink}` : '';
  return `https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${encodeURIComponent(`Join ${meetingTitle} on VYNQ. Open this link in any browser; the host will admit you.${botNote}`)}`;
}
