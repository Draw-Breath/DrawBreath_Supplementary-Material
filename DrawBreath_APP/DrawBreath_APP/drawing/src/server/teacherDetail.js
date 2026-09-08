function groupTeacherAttempts(rows, mapAttempt) {
  const grouped = new Map();
  for (const row of rows) {
    let participant = grouped.get(row.participant_id);
    if (!participant) {
      participant = {
        id: row.participant_id,
        participantId: row.participant_id,
        name: row.display_name,
        studentNumber: row.student_number,
        joinedAt: row.created_at,
        submitted: false,
        attempts: []
      };
      grouped.set(row.participant_id, participant);
    }
    const attempt = mapAttempt(row);
    participant.attempts.push(attempt);
    if (attempt.status === 'submitted') participant.submitted = true;
  }
  const participants = [...grouped.values()];
  const attempts = participants.flatMap((participant) => participant.attempts);
  return {
    participants,
    summary: {
      joinedCount: participants.length,
      submittedCount: participants.filter((participant) => participant.submitted).length,
      attemptCount: attempts.length,
      submittedAttemptCount: attempts.filter((attempt) => attempt.status === 'submitted').length
    }
  };
}

module.exports = { groupTeacherAttempts };
