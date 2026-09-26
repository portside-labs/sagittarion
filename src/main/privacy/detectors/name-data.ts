// Common given names and surnames for the name heuristics, lower case without accents. Names that are also everyday
// words, months, places or brands (May, Jordan, Grant, Austin, Charlotte…) are removed below: on their own they are
// only treated as names with context such as a title or "named". The semantic model covers what a list cannot.

const GIVEN_LIST = `
mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty margaret sandra ashley kimberly
emily donna michelle carol amanda melissa deborah stephanie rebecca sharon laura cynthia kathleen amy angela shirley anna
brenda pamela emma nicole helen samantha katherine christine debra rachel carolyn janet catherine maria heather diane julie
joyce joan evelyn olivia judith megan cheryl martha andrea frances hannah jacqueline ann gloria jean kathryn alice teresa sara
janice doris julia judy abigail marie denise beverly theresa marilyn danielle diana brittany natalie sophia isabella alexis
kayla tiffany jane lori tammy kristen kristin kristina ella chloe mia ava harper amelia aria scarlett layla zoey nora lillian
addison aubrey ellie stella natalia leah hailey audrey claire skylar lucy paisley everly caroline emilia maya naomi aaliyah
elena ariana allison gabriella madelyn cora eva adeline gianna isla eliana nevaeh sadie piper lydia alexa josephine emery
delilah arianna vivian kaylee sophie brielle madeline peyton rylee clara hadley melanie mackenzie reagan adalynn liliana
aubree katherine isabelle raelynn athena ximena arya leilani kylie alexandra lyla amaya eliza brianna khloe jasmine norah
annabelle valeria emerson adalyn ryleigh eden emersyn anastasia alyssa juliana esther ariel cecilia valerie alina molly aliyah
lilly finley jordyn eloise elise remi teagan sloane laila lucia juliette sienna elliana londyn ayla callie gracie josie amara
jocelyn daniela everleigh mya alana alaina mckenzie presley journee rosalie brynlee joanna paige ana mariah brooklynn payton
marley fiona adelyn alivia noelle gemma vanessa makayla angelina adaline catalina alayna julianna leila lola adriana juliet
jayla tessa lia delaney selena blakely ada camille zara malia gwendolyn rosemary wendy tracy tina stacy shannon erin
kelly colleen maureen bridget kathy peggy dorothy mildred ruth virginia jeanette lorraine rita connie bonnie vera agnes
edna ethel gladys irene louise norma phyllis thelma wanda yvonne yolanda rhonda kristy jill joy tanya sonia monica veronica
priscilla miriam naomi rebekah abby becky jenny katie maggie nikki vicky vickie gina lena nina tara dana carla lindsay lindsey
whitney chelsea courtney kendra kendall bethany brianna jillian meredith leslie tamara natasha
james robert john michael david william richard joseph thomas christopher charles daniel matthew anthony donald steven andrew
paul joshua kenneth kevin brian george timothy ronald jason edward jeffrey ryan jacob gary nicholas eric jonathan stephen larry
justin scott brandon benjamin samuel gregory alexander patrick raymond jack dennis jerry aaron jose adam nathan henry
zachary douglas peter kyle noah ethan jeremy walter keith roger terry sean gerald carl harold dylan arthur lawrence
jesse bryan billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent roy ralph bobby russell bradley
philip phillip eugene liam oliver lucas levi sebastian mateo owen theodore aiden grayson leo julian luke isaac jayden hudson ezra
josiah elias isaiah jaxon asher nolan cameron adrian easton connor jeremiah colton axel landon kai ian jonah waylon
greyson roman carson dominic jace ryder evan jameson bennett declan silas micah xavier emmett brooks ezekiel carlos everett
weston harrison diego rhett ryker ivan kayden damian sawyer cole luis milo ashton luca tristan braxton antonio calvin brantley
giovanni jude alex judah bryson kaden maddox jasper arlo ayden karter emiliano rafael barrett abel kaiden mason carter cooper
parker taylor jackie kenny danny tommy jimmy johnny freddie franklin frederick howard herbert harvey leonard marvin melvin
clarence stanley norman ernest francis frank louis martin victor oscar edgar alfred bernard curtis glenn gordon jerome leroy
lloyd leon mario tony tyrone darnell darius malik deshawn jamal terrell andre marcus reginald cedric dwayne lamar travis
derek derrick shane brett troy todd chad kurt craig dale neil wesley rodney lance allen kirk gregg jared caleb joel
spencer mitchell marshall seth garrett colin trevor devin blake brady tanner dustin cody corey casey jeffery
jose juan luis carlos jorge miguel pedro alejandro manuel francisco javier fernando ricardo eduardo roberto sergio andres diego
pablo raul alberto enrique ramon oscar hector gustavo arturo mario hugo lucia maria carmen ana isabel laura marta elena sofia
paula valentina camila daniela gabriela mariana fernanda alejandra andrea veronica patricia teresa pilar beatriz silvia
cristina raquel yolanda lourdes guadalupe consuelo esperanza ines concepcion ximena renata julieta agustina catalina josefina
martina valeria santino thiago matias joaquin emiliano bautista benjamin
jean pierre michel philippe alain jacques bernard francois nicolas julien sebastien olivier christophe frederic laurent stephane
thierry pascal eric guillaume antoine mathieu maxime romain hugo louis lucas gabriel raphael arthur jules theo marie nathalie
isabelle sylvie catherine francoise valerie sandrine veronique christine celine aurelie emilie camille lea manon chloe ines
louise alice margaux oceane mathilde elodie
hans peter wolfgang klaus jurgen juergen dieter horst uwe gunter guenter stefan andreas thomas michael markus matthias sebastian
tobias florian lukas leon finn jonas felix maximilian ursula monika petra sabine renate karin brigitte ingrid gisela
helga heike claudia susanne birgit anja katrin lena lea hannah mia lina
giuseppe giovanni antonio luigi francesco angelo vincenzo pietro salvatore carlo franco domenico paolo michele giorgio alberto
lorenzo matteo alessandro davide simone federico riccardo gabriele leonardo tommaso giulia chiara francesca federica alessia
elisa roberta paola giovanna
joao antonio francisco paulo pedro luiz marcos marcelo eduardo felipe raimundo rodrigo manoel mateus andre fabio leonardo
gustavo guilherme leandro tiago anderson marcio sebastiao francisca antonia adriana juliana marcia aline bruna jessica
leticia luciana vanessa vitoria larissa claudia rita luana sonia eliane
aarav vivaan aditya vihaan arjun reyansh ayaan krishna ishaan shaurya atharv advik pranav advaith dhruv kabir ritvik aarush
darsh rahul amit ravi sanjay vijay suresh ramesh rajesh mahesh anil sunil manoj deepak ashok vikram arun prakash sandeep rohit
rakesh mukesh dinesh ajay vinod naresh ganesh harish nitin gaurav saurabh abhishek ankit ankur varun karan rohan siddharth
aditi priya ananya diya saanvi aadhya anika navya myra anvi riya kavya neha pooja anjali sneha divya shreya swati
deepika priyanka sunita anita kavita rekha meena geeta sita lakshmi radha usha asha nisha lata shanti savita suman manisha
preeti jyoti ritu seema sapna aarti
muhammad mohammed mohammad mohamed ahmed ahmad omar umar hassan hussein hussain ibrahim yusuf youssef khalid mustafa abdullah
abdul hamza bilal tariq karim kareem samir faisal nasser rashid saeed jamal walid adel zayd zaid fatima aisha ayesha
khadija maryam mariam zainab zeinab layla leila huda amina yasmin yasmine salma rania farah iman
kwame kofi kwabena kojo akua abena adwoa chinedu chukwuemeka emeka obinna ngozi chiamaka adaeze oluwaseun olumide tunde
funmilayo folake ayodele babajide segun thabo sipho themba mandla nomvula lerato zanele amani baraka juma zuri wanjiru njeri
xiaoming xiaohong jianguo zhiwei jiahao haoran yuxuan zihan yichen wenjie junjie xinyi yuting jiayi hiroshi takashi kenji akira
satoshi haruto yuto sota hina yuna minato haruki kenta daiki shota naoki taro jiro akiko keiko yoko naoko tomoko sachiko
yumi ayumi kaori megumi minjun seoyeon jihoon jiwoo minseo seojun doyun haeun jiho
ivan dmitri dmitry sergei sergey alexei alexey andrei andrey nikolai mikhail vladimir yuri boris igor oleg pavel viktor natasha
tatiana svetlana irina ekaterina yulia oksana galina ludmila
иван дмитрий сергей алексей андрей николай михаил владимир юрий борис игорь олег павел виктор александр максим артём
наталья ольга татьяна светлана ирина елена екатерина анастасия юлия оксана мария анна
lars sven erik anders nils johan karl olof bjorn astrid sigrid freya kristian mikkel soren magnus henrik jens ole piotr
krzysztof tomasz pawel marcin michal jakub agnieszka katarzyna malgorzata magdalena ewa nikos giorgos yiannis dimitris eleni
katerina pieter willem johannes daan bram lotte sanne femke anouk seamus siobhan niamh aoife ciara saoirse oisin cian padraig
eoin conor fionn ronan hamish fergus mhairi eilidh dafydd rhys gareth bethan cerys
`

const SURNAME_LIST = `
smith johnson williams jones garcia miller davis rodriguez martinez hernandez lopez gonzalez wilson anderson thompson harris
sanchez clark ramirez lewis robinson allen wright scott torres nguyen flores adams nelson rivera campbell mitchell roberts gomez
phillips evans diaz cruz edwards collins reyes stewart morris morales murphy rogers gutierrez ortiz peterson ramos cox
richardson watson chavez bennett mendoza ruiz hughes alvarez castillo sanders patel myers foster jimenez powell jenkins perry
sullivan coleman henderson gonzales fisher vasquez simmons romero patterson reynolds griffin wallace moreno hayes bryant herrera
gibson ellis tran medina aguilar stevens murray castro owens fernandez mcdonald kennedy vargas freeman webb tucker guzman
crawford olson simpson gordon mendez silva snyder dixon munoz hicks holmes palmer wagner robertson boyd salazar meyer schmidt
garza daniels ferguson nichols stephens soto weaver payne dunn kelley spencer hawkins pierce hansen peters santos elliott
cunningham duncan armstrong carroll andrews alvarado delgado perkins hoffman johnston matthews pena contreras sandoval guerrero
chapman rios estrada ortega watkins greene nunez wheeler valdez harper larson maldonado morrison carlson dominguez obrien
o'brien lynch singh vega montgomery jensen williamson espinoza howell wong mccoy garrett weber welch rojas marquez yang
padilla walsh schultz fowler mejia davidson acosta juarez newman pearson cortez schneider navarro figueroa keller avila
molina hopkins campos barnett chambers caldwell lambert miranda ayala frazier carrillo fleming rhodes shelton schwartz norris
jennings duran walters cohen mcdaniel vaughn becker deleon benson haynes horton pham thornton zimmerman dawson fletcher
mccarthy robles cervantes solis erickson reeves chang klein salinas fuentes baldwin velasquez higgins aguirre cummings
chandler bowen ochoa robbins liu ramsey griffith oconnor o'connor cardenas pacheco calderon swanson khan rodgers serrano
fitzgerald rosales stevenson christensen mclaughlin harmon mcgee doyle garner burgess trujillo adkins goodman goodwin fischer
huang delacruz montoya hines mullins castaneda malone sherman hubbard hodges zhang saunders gallagher hammond townsend ingram
gallegos schroeder maxwell camacho strickland parsons harrington glover osborne buchanan patton ibarra suarez orozco escobar
mcguire mueller muller hartman kramer mcbride velazquez mccormick yates hogan macias villanueva zamora villarreal pineda
burnett mercado santana bautista shaffer trevino mckenzie cochran morton wilkins petersen nicholson holloway lozano rangel
valenzuela underwood whitaker decker yoder zuniga wilcox melendez roberson larsen davenport copeland massey rocha huynh
singleton galvan wilkinson atkinson velez kowalski nowak wisniewski kovac horvat novak dubois lefebvre moreau fournier girard
bonnet dupont rousseau schulz hoffmann koch richter neumann schwarz zimmermann kruger hartmann krause lehmann kohler rossi
russo ferrari esposito bianchi romano colombo ricci marino greco gallo conti costa giordano mancini rizzo lombardi moretti
ferreira pereira oliveira rodrigues almeida nascimento araujo fernandes carvalho gomes martins ribeiro alves monteiro mendes
barros freitas barbosa pinto moura cavalcanti dias cardoso yamamoto tanaka watanabe suzuki takahashi ito nakamura kobayashi
saito kato yoshida yamada sasaki matsumoto inoue kimura hayashi shimizu yamaguchi choi jung kang yoon jang kwon hwang ahn
jeon zhao zhou xu guo luo zheng liang xie deng feng zeng xiao cai kumar sharma gupta reddy iyer nair mehta joshi desai patil
kulkarni chatterjee banerjee mukherjee ghosh chopra kapoor malhotra verma agarwal pillai menon naidu hussain ahmed rahman
chowdhury begum hossain siddiqui qureshi sheikh malik mirza abbasi okafor okonkwo adeyemi ogunleye mensah owusu boateng
asante nkosi dlamini ndlovu mokoena kamau otieno ivanov petrov smirnov kuznetsov popov sokolov lebedev kozlov novikov
morozov volkov
`

/** Also everyday words, months, places or brands: names only with context. */
const AMBIGUOUS = `
may june april august autumn summer winter dawn eve faith hope joy grace charity constance patience prudence mercy honor
liberty destiny harmony melody serenity trinity unity genesis rose lily violet iris daisy holly ivy hazel heather jasmine olive
poppy ruby pearl amber crystal jade coral sky skye rain river storm sunny brook brooke cliff dale glen heath forest stone will
bill mark grant chase hunter price page long young brown white green black gray grey king rich frank earl duke prince guy pat
sue rob don art gene ray max bob nick norm pierce drew wade lance miles rusty sandy buck colt cash sterling jordan paris
georgia virginia carolina dakota florence austin victoria sydney chelsea brooklyn madison phoenix savannah vienna asia india
china israel lincoln kent troy tyler marshall bishop angel christian justice royal kitty candy brandy ginger honey cherry pepper
mercedes harley hazel sage basil juniper willow aspen cedar rowan bay moss fern ash penny gem beau dean regina wren robin jay
drake fox wolf bear chance clay reed wood hill hall baker cook turner walker carpenter mason hunter archer porter fisher
charlotte orlando dallas houston denver cleveland irving eugene raleigh chester warren clinton hamilton wellington bristol preston
winston santiago valencia sofia lima siena geneva augusta alexandria adelaide jackson london kingston salem camden jan
chad jersey marion beverly lincoln tucker wallace booker major shelby spencer carson emerson taylor parker cooper carter
august summer ellis joel vera rita tina jean ann louis lucas paul thomas martin james pearl rose
`

/** Lower case, accents and apostrophes folded, for list lookups. */
export function nameKey(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
}

function set(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter(Boolean).map(nameKey))
}

const ambiguous = set(AMBIGUOUS)

/**
 * Ambiguous names that are still far more often people than anything else when written with a capital. They stay
 * out of AMBIGUOUS so "Paul", "Thomas" or "Martin" are found; the others are only names with context.
 */
const PERSON_FIRST = set('paul thomas martin james louis lucas joel vera rita tina jean ann ellis taylor parker cooper carter mason spencer wallace tucker carson emerson')

export const GIVEN_NAMES = new Set([...set(GIVEN_LIST)].filter((n) => !ambiguous.has(n) || PERSON_FIRST.has(n)))
export const SURNAMES = new Set([...set(SURNAME_LIST)].filter((n) => !ambiguous.has(n) || PERSON_FIRST.has(n)))
export const AMBIGUOUS_NAMES = new Set([...ambiguous].filter((n) => !PERSON_FIRST.has(n)))
