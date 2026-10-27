# Colonos — Catan digital

Implementación completa de Catan para jugar por turnos en un mismo dispositivo,
sin conexión a internet. El tablero clásico (19 casillas) y el ampliado de la
extensión 5-6 jugadores (30 casillas) están los dos incluidos, con todas las
reglas del juego base.

```bash
npm install
npm run dev      # abre http://localhost:5173
npm test         # 243 tests: reglas, tablero e interfaz
npm run fuzz     # partidas de bots aleatorios comprobando invariantes
npm run build    # compilación de producción a dist/
```

## Qué incluye

**Reglas completas del juego base.** Colocación inicial en serpiente con reparto
de recursos del segundo poblado; producción por tirada con poblados (1 carta) y
ciudades (2); la regla oficial de escasez del banco (si no llega para todos los
que producen, nadie recibe, salvo que haya un único beneficiario); el 7 con
descarte de la mitad de la mano, movimiento del ladrón y robo; las cinco cartas
de desarrollo con sus restricciones (una por turno, nunca el turno de compra);
comercio marítimo 4:1, 3:1 y 2:1 según puertos; comercio entre jugadores con
oferta, respuestas y cierre; ruta comercial más larga y mayor ejército, ambas
con su regla de desempate.

**Extensión 5-6 jugadores.** Tablero de 30 casillas (filas de 3-4-5-6-5-4-3),
28 fichas numéricas, 11 puertos, mazo de 34 cartas de desarrollo y banco de 24
cartas por recurso.

No se implementa la **fase de construcción especial**. El turno va siempre de
tirar los dados a construir y comerciar y de ahí al siguiente jugador, con
cualquier número de jugadores: una fase intermedia que hay que cerrar con un
botón aparte rompía ese ritmo y confundía más de lo que aportaba.

**Partida en red local.** Cada uno en su dispositivo, en la misma wifi. Uno
levanta el servidor y dicta un código de cuatro letras; los demás abren la misma
dirección desde el móvil o el portátil y lo escriben. No hay que instalar nada
en los otros aparatos: el servidor sirve el juego y atiende la partida en el
mismo puerto.

```
npm run lan          # compila y levanta el servidor
```

Imprime las direcciones de la máquina en la red para poder dictarlas. Los
asientos vacíos se pueden rellenar con bots, que corren en el servidor.

Al terminar una partida **nadie sale del servidor**: la sala vuelve a la
pantalla de espera con la misma gente, los mismos asientos y el mismo código, y
desde ahí se empieza otra sin volver a dictar nada. Cerrar la conexión al cantar
la victoria, que era lo que hacía antes, obligaba a montar la mesa de cero cada
vez.

**Lo que ve cada uno.** El servidor es la única autoridad: los clientes
*proponen* jugadas y esperan. Antes de mandar el estado a cada jugador se le
quita lo que no le toca ver —las manos ajenas, el mazo de desarrollo y **el
estado del generador de azar**, que revelaría todas las tiradas futuras—, y en
su lugar viajan solo los recuentos públicos. Mandar el estado entero y confiar
en que la interfaz no lo enseñe no serviría de nada: el mensaje se lee entero
desde la consola del navegador.

Si se corta la wifi, el cliente reintenta solo y vuelve a **su** asiento con sus
cartas, gracias a una ficha de sesión.

> **Alcance.** Está pensado para una red de confianza: el tráfico va en claro y
> el único control de acceso es el código de la sala. Vale para la wifi de casa;
> no lo expongas a internet tal cual.

**Modo local por turnos.** Cada cambio de jugador levanta un escudo de
privacidad a pantalla completa: la mano solo se descubre cuando quien
corresponde confirma que tiene el dispositivo delante.

**Tablero en 3D.** La isla se ve en perspectiva sobre una mesa de madera:
las casillas son prismas con grosor, el mar rodea la costa un escalón por
debajo, y poblados, ciudades, caminos y ladrón son sólidos con caras
iluminadas por un foco direccional.

**Maqueta, no tapete.** La casilla pone el *suelo* —tierra, hierba segada,
surcos de arado, roca, arena— y de él se levantan *objetos* con volumen: abetos,
peñascos nevados, pilas de ladrillo, gavillas atadas, ovejas y cactus,
iluminados por el mismo foco que las piezas. Nada se pinta tumbado: un objeto
plano dibujado sobre una casilla en perspectiva sale aplastado contra el suelo,
como una pegatina, y eso es exactamente lo que había antes. Los objetos se
calculan una vez por tablero y dejan libre el centro para la ficha numérica.

**El tablero y la mano se parecen.** La oveja del prado es la misma oveja que la
carta de lana; la gavilla del campo, la de la carta de trigo; la roca de la
montaña, la de la carta de mineral. Quien busca en el tablero de dónde sacar
lana reconoce lo que lleva en la mano sin traducir nada.

**Puertos con su material.** El cartel de un puerto 2:1 enseña el objeto que
compra —los mismos troncos, la misma piedra que la carta— con la proporción en
una cinta cruzada debajo. Lo que se ve en el puerto es exactamente lo que hay
que buscar en la mano.

**Sonido sintetizado.** Cada interacción suena a lo que es: madera al poner un
camino, piedra al subir una ciudad, metal en el caballero, un golpe sordo y
grave con el ladrón, un arpegio al cobrar la cosecha y fanfarria al ganar. Como
con las imágenes, no hay ni un archivo de audio: todo sale de osciladores y
ruido filtrado de la Web Audio API. Se apaga desde la barra superior.

**Cámara libre.** Arrastra para girar el tablero **la vuelta entera** y verlo
desde cualquier lado, la rueda acerca y aleja manteniendo quieto el punto bajo
el cursor, y el botón derecho (o Mayús y arrastrar) desplaza la vista. Doble
clic vuelve al encuadre inicial.

**Construir pulsando el mapa.** No hace falta elegir antes en un botón: el
tablero marca en dorado todo lo que puedes levantar ahora y muestra la **pieza
fantasma** de lo que saldría —camino, poblado o ciudad— en tu color. Un clic la
construye; sobre un poblado tuyo, la mejora a ciudad. Los botones de la barra
pasan a ser un filtro para cuando hay demasiados sitios marcados a la vez.

**Chat sobre el tablero.** Va flotando en la esquina inferior izquierda del
lienzo, translúcido y desvaído mientras no se usa; se aclara al pasar por
encima o al escribir. No ocupa columna, así que no le quita ancho a lo único
que se aprovecha de crecer, y no hace falta esconderlo en pantallas estrechas.
Los clics que no caen sobre un mensaje o la caja de texto **atraviesan** el
chat y llegan al tablero: si no, un rectángulo invisible se comería esa esquina
y no se podría construir debajo.

En red es una conversación de verdad, con avisos del propio juego («Bruno ha
perdido la conexión»); quien entra a media partida ve lo que se ha dicho antes.
El nombre lo pone el **servidor** según el asiento, no el mensaje: si viniera en
el mensaje, cualquiera podría firmar como otro. En partida local hace de bloc
compartido, atribuido a quien tiene la mano delante.

**Recuerda tu nombre.** Una casilla en las dos pantallas de configuración —la
local y la de red— guarda el nombre en el navegador y lo trae puesto la próxima
vez. Al desmarcarla se **borra**, no se queda guardado esperando: si alguien
dice que no lo recuerdes, no hay que recordarlo. Y si el navegador tiene los
datos de sitio bloqueados, leerlo *lanza* en vez de devolver vacío, así que el
acceso va envuelto y el juego arranca igual sin recordar nada.

**Las ventanas forzadas son de quien le toca.** El descarte por un 7 y el
selector de víctima del ladrón se le enseñan a quien tiene que decidir **y**
está delante de esa pantalla. Son dos condiciones y hacen falta las dos: la
primera es la que arregla el juego en red, donde no hay escudo de privacidad
que tape de casualidad; la segunda es la que impide que el caballero de un bot
asome medio segundo —lo que el bot tarda en pensar— ofreciéndote una elección
que no era tuya.

**Dados grandes y pulsables.** Son cubos de verdad: se construyen en tres
dimensiones, se giran y se proyectan, y los puntos van pintados *sobre* cada
cara, así que se deforman con ella. El valor queda arriba y las caras opuestas
suman siete. Hacen lo mismo que el botón «Tirar dados»: cuando toca tirar se
anuncian con un aro dorado, voltean sobre sus tres ejes al pulsarlos y dejan la
suma en una chapa.

**Los dados también pasan el turno.** Son un mando de dos posiciones: al
principio del turno tiran, y una vez tirados pasan («PASAR TURNO» en verde
sobre ellos). El mismo gesto en el mismo sitio para las dos cosas que enmarcan
una jugada, sin cruzar la pantalla a buscar otro botón.

**Marcador de jugadores.** Cada panel lleva sus cifras públicas con icono:
cartas en mano, cartas de desarrollo, poblados, ciudades, ruta más larga y
caballeros jugados. Quien tiene la ruta más larga o el mayor ejército lo lleva
marcado en dorado. Lo secreto sigue siendo secreto: se ve *cuántas* cartas
tiene cada uno, nunca cuáles.

**La mano, entera y a la vista.** Recursos y cartas de desarrollo van juntos en
la barra inferior; las de desarrollo se juegan pulsándolas, sin ventana
intermedia. La barra tiene **altura fija**: su contenido cambia con la fase, y
si creciera y menguara arrastraría al tablero y a la cámara con él.

**Tus piezas, sobre la mesa.** Los caminos, poblados y ciudades que te quedan no
se cuentan en un texto: están puestos en una bandeja junto al tablero, con la
misma geometría y la misma luz que las piezas ya colocadas. El hueco se mide con
la dotación completa de la partida, así que no baila al construir.

**Reloj de jugada.** 30 segundos por jugada, con aviso en rojo en los últimos
diez. Al agotarse, la interfaz cumple el trámite pendiente —tirar, descartar,
mover el ladrón, colocar en la salida— o cierra el turno; nunca construye ni
gasta recursos por ti. Se puede quitar desde la barra superior. No corre
mientras juega un bot, con el escudo de privacidad puesto ni con una oferta
sobre la mesa.

**Intercambios con cartas.** Banco y ofertas entre jugadores comparten la misma
mesa visual: dos filas con flecha —roja lo que sale de tu mano, verde lo que
entra— y raíles de cartas debajo. Se pulsa la carta, no un más y un menos: al
elegir mineral contra un puerto 3:1 aparecen las tres cartas que entregas.

**El terreno y el material son cosas distintas.** La casilla es un *paisaje*:
bosque, colinas, pasto con ovejas, campo de trigo, montañas nevadas, desierto,
con variaciones estables sembradas a partir del identificador de cada casilla.
Lo que se coge con la mano es un *objeto*: troncos cortados con sus anillos,
ladrillos apilados, una oveja, una gavilla atada y piedra con vetas de cristal
—piedra, no una montaña, porque una montaña no cabe en una carta—. Cada uno se
dibuja donde toca, y la carta se lee entera a los 58×78 píxeles de la barra de
la mano, que es donde de verdad se mira.

**Ilustración propia.** No hay ni un archivo de imagen en el proyecto: todo se
dibuja con trazos de canvas, y los iconos de la interfaz son SVG con el detalle
interior **calado**, no pintado, para que se vea sobre cualquier fondo sin
necesitar un segundo color. El dibujo plano de la loseta va a media densidad
porque encima de él ya hay objetos sólidos. Incluye animación de dados, de
colocación de piezas y del salto del ladrón. Al tirar, cada casilla que produce
levanta su carta de recurso sobre un aro dorado, así se ve de dónde sale cada
cobro.

## Arquitectura

La separación importante es entre el **motor** y todo lo demás. `src/engine/`
es TypeScript puro: no toca el DOM, no llama a `Math.random` ni mira el reloj, y
no sabe nada de cómo se dibuja el juego. Su interfaz es la de un reductor:

```ts
const state  = createGame(players, { seed });      // partida determinista
const moves  = getLegalActions(state, playerId);   // todo lo que puede hacer
const result = applyAction(state, moves[0]);       // (estado, acción) -> estado
```

Esa forma es deliberada, y es la respuesta a los dos requisitos de futuro:

- **Bots.** Un bot es una función que elige entre las acciones legales. No
  necesita ningún acceso privilegiado: ve el mismo estado que verá un cliente
  remoto. El contrato ya está escrito en `src/ai/types.ts`, y `RandomBot` es la
  prueba de que basta para jugar una partida entera.
- **Red.** Ya está hecho, y salió casi gratis por esta forma. Como el azar vive dentro del estado (semilla + generador
  determinista), una partida se reconstruye por completo a partir de la semilla
  y la lista de acciones. Un servidor puede revalidar cada acción con el mismo
  `validate()` que usa el cliente, sin lógica duplicada.

```
src/
  engine/          motor de reglas — TypeScript puro, sin DOM ni azar externo
    rng.ts         generador determinista; todo el azar pasa por aquí
    hex.ts         geometría hexagonal en rejilla entera (ver más abajo)
    board.ts       generación de tablero, costa y reparto de puertos
    types.ts       modelo de dominio
    constants.ts   costes, piezas y composición de cada variante
    state.ts       creación de partida, recursos y puntuación
    legal.ts       validación y enumeración de acciones legales
    reducer.ts     aplicación de acciones
    longest-road.ts  ruta comercial más larga
  ai/              contrato de bot, bot aleatorio y bucle de auto-juego
  net/             red — protocolo compartido, censura del estado y cliente
    protocol.ts    los mensajes, y la validación de lo que llega de fuera
    redact.ts      qué se le quita al estado antes de mandárselo a cada uno
    client.ts      el WebSocket del navegador, con reconexión
  ui/              interfaz — escena 3D, arte procedural y controlador
    camera.ts      cámara en perspectiva: proyección, profundidad e impacto
    art3d.ts       sólidos: prismas, casas, caminos, muelles y dados
    art.ts         texturas de casilla, motivos de terreno y fichas numéricas
    props.ts       objetos 3d de cada terreno (árboles, rocas, ovejas...)
    materials.ts   los cinco materiales como objeto: troncos, ladrillos, oveja...
    cards.ts       cartas de recurso
    die3d.ts       el dado como cubo proyectado
    icons.ts       iconos SVG de la interfaz
    sound.ts       efectos sintetizados con Web Audio, sin archivos de audio
    board-view.ts  escena, orden de pintado e interacción con el tablero
    app.ts         controlador de la partida y paneles
    lan.ts         pantalla de red: crear sala, entrar y esperar
server/            servidor de partidas en red local
  index.ts         HTTP (sirve dist/) y WebSocket, en el mismo puerto
  room.ts          una sala: asientos, reconexión y la partida autoritativa
tools/
  render-board.ts  renderiza el tablero a PNG sin navegador (usa la vista real)
  render-icons.ts  vuelca los iconos de la interfaz a un PNG para revisarlos
  render-cards.ts  dibuja las cartas de recurso a PNG, a tamaño real y ampliadas
  fuzz.ts          partidas masivas de bots comprobando invariantes
tests/             reglas, tablero, interfaz y red
```

### La geometría hexagonal

Es la parte que más fácil se implementa mal, así que va explicada. En lugar de
calcular la posición de cada esquina en coma flotante y luego decidir con un
epsilon si dos esquinas «son la misma», se trabaja en una rejilla **entera**
duplicada:

```
centro del hexágono (q, r)  ->  X = 2q + r,  Y = 3r
esquina i                   ->  centro + desplazamiento entero
```

Dos hexágonos vecinos producen literalmente el mismo par `(X, Y)` para la
esquina que comparten, así que la identidad de un cruce es igualdad de enteros y
no hay tolerancias en ninguna parte. Las aristas se identifican por sus dos
cruces ordenados de forma estable, de modo que `(a, b)` y `(b, a)` son la misma
clave.

Los puertos no están codificados a mano: se recorre el perímetro de la isla
siguiendo las aristas que pertenecen a un solo hexágono y se reparten a
intervalos lo más parejos posible. El mismo código sirve para las dos variantes
de tablero.

### Cómo se prueba

243 tests, y los que más valen no son los unitarios:

- **Fuzzer de auto-juego.** Bots aleatorios juegan partidas completas de 2 a 6
  jugadores. Recorren combinaciones de reglas que ningún test escrito a mano
  cubriría, y verifican que la partida siempre llega a un ganador sin quedarse
  bloqueada.
- **Invariantes durante toda la partida.** En cada acción se comprueba que
  banco + manos = total de cartas inicial, que nadie tiene cantidades negativas,
  que las piezas colocadas más las de la reserva cuadran con las 15/5/4 de cada
  jugador, que la longitud de ruta guardada coincide con recalcularla desde cero
  y que nunca hay dos edificios en cruces contiguos.
- **Interfaz pulsando de verdad.** Con jsdom y un contexto de canvas simulado se
  juega una partida entera *a través de la interfaz*, y además se ejercitan los
  botones y las ventanas una por una: cambiar con el banco, descartar por un 7,
  jugar un monopolio, negociar un intercambio, mover el ladrón. Es donde
  aparecen los fallos de cableado entre capas, que ningún test del motor ve.

```bash
npm run fuzz 500                                     # 500 partidas con invariantes
npx tsx tools/render-board.ts 20250820 4 board.png   # PNG del tablero clásico
npx tsx tools/render-board.ts 777 6 board6.png       # PNG del tablero ampliado
```

## Decisiones que conviene conocer

- **Puertos de la extensión.** Las fuentes no coinciden en el reparto exacto de
  los 11 puertos del tablero 5-6. Se usan 5 genéricos 3:1 y 6 específicos 2:1
  (uno por recurso más un segundo de lana). Cambiarlo es una línea en
  `constants.ts`.
- **Fichas 6 y 8.** El reparto aleatorio reintenta hasta que ningún 6 quede
  pegado a otro 6 u 8, que es la restricción del montaje oficial.
- **Comercio en pantalla compartida.** Como todos los jugadores están alrededor
  del mismo dispositivo, las respuestas a una oferta se resuelven en una sola
  ventana donde cada uno pulsa su fila. No se revela ninguna mano ajena.
- **Turnos que se congelan.** Dos situaciones bloquean el resto del turno hasta
  resolverse: los caminos pendientes de la carta de carreteras, y una oferta de
  intercambio sobre la mesa. Sin esa regla se llega a estados absurdos — jugar
  la carta, tirar los dados y acabar colocando caminos gratis en mitad del
  robo, o negociar mientras se mueve el ladrón.
- **Momento de la victoria.** Se comprueba tras cada acción del jugador y
  también al empezar su turno. Lo segundo hace falta porque se pueden alcanzar
  los 10 puntos durante el turno de otro: basta con que un tercero pierda la
  ruta comercial más larga y el título cambie de manos.

## Qué falta para las siguientes fases

El MVP es local y sin red, tal como se pidió. Lo que queda preparado:

1. **Bots con dificultad.** Implementar `Bot` en `src/ai/`. `getLegalActions`
   ya da el espacio de jugadas; solo el descarte y la propuesta de intercambio
   necesitan heurística propia, y tienen su método en el contrato. El bucle de
   `self-play.ts` es el mismo que usará la interfaz.
2. **Partida en red.** El servidor guarda semilla y lista de acciones, valida
   con `validate()` y difunde el estado. El cliente ya está escrito contra esa
   misma interfaz.
3. **Expansiones.** El modelo de acciones y fases admite añadir *Ciudades y
   Caballeros* o *Navegantes* como nuevas variantes de `VARIANT_SETUP` más
   acciones adicionales, sin reescribir el núcleo.
