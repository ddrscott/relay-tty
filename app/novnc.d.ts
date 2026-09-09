// noVNC ships no types. The route wraps the RFB instance in its own
// structural type (see app/routes/desktop.tsx), so `any` here is enough.
declare module "@novnc/novnc" {
  const RFB: any;
  export default RFB;
}
