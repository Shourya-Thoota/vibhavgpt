// The participant's packet, laid out like a printed DECA event document.
export function Packet({ doc }) {
  return (
    <article className="packet" aria-label={`${doc.kind} packet`}>
      <div className="packet__top">
        <span>{doc.cluster}</span>
        <span>DECANet Practice</span>
      </div>
      <h1 className="packet__event">{doc.eventName}</h1>
      <div className="packet__kind">{doc.kind} #{doc.number} · {doc.eventCode}</div>
      <div className="packet__ia">Instructional Area: {doc.instructionalArea}</div>

      <h3>Participant Instructions</h3>
      <ul>{doc.instructions.map((line) => <li key={line}>{line}</li>)}</ul>

      <h3>21st Century Skills</h3>
      <ul className="packet__skills">
        {doc.centurySkills.map((skill) => <li key={skill.label}><strong>{skill.label}:</strong> {skill.detail}</li>)}
      </ul>

      <h3>Performance Indicators</h3>
      <ol>{doc.performanceIndicators.map((indicator) => <li key={indicator}>{indicator}</li>)}</ol>

      <h3>{doc.kind === "Case Study" ? "Case Study Situation" : "Event Situation"}</h3>
      {doc.situation.map((paragraph) => <p key={paragraph.slice(0, 40)}>{paragraph}</p>)}

      <div className="packet__foot">
        <span>{doc.title}</span>
        <span>Your role: {doc.participantRole} · Judge: {doc.judgeRole}</span>
      </div>
    </article>
  );
}
